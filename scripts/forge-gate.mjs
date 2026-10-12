#!/usr/bin/env node
/** Fail-closed local Git review gate. Does not push, merge, or advance refs. */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { evidenceDigest, isInside } from './forge-evidence.mjs';

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const ID = /^[a-z][a-z0-9_.-]{0,63}$/;
const gitEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
const digest = data => createHash('sha256').update(data).digest('hex');

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv,
  }).trim();
}

function attempt(repo, ...args) {
  return spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, env: gitEnv,
  });
}

function commitExists(repo, sha) {
  if (!SHA.test(sha ?? '')) return false;
  try { return git(repo, 'rev-parse', '--verify', sha + '^{commit}') === sha; }
  catch { return false; }
}

function changedPaths(repo, base, head) {
  const r = spawnSync('git', ['-C', repo, 'diff', '--no-renames', '--name-only', '-z', base, head], {
    encoding: 'buffer', maxBuffer: 4 * 1024 * 1024, env: gitEnv,
  });
  if (r.error || r.status !== 0) throw new Error('Unable to inspect complete Git diff');
  return r.stdout.toString('utf8').split('\0').filter(Boolean).sort();
}

// Canonical signed bytes are independent of incidental JSON key and check order.
export function canonicalAttestation(raw) {
  return JSON.stringify({
    schemaVersion: raw.schemaVersion,
    issuer: raw.issuer,
    baseSha: raw.baseSha,
    targetSha: raw.targetSha,
    subjectSha: raw.subjectSha,
    checks: raw.checks.map(c => ({
      id: c.id, status: c.status, evidenceSha256: c.evidenceSha256 ?? null,
    })).sort((a, b) => a.id.localeCompare(b.id)),
  });
}

function inspectAttestation(raw, p, reasons) {
  const checks = [];
  let verified = false;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      raw.schemaVersion !== 2 || !Array.isArray(raw.checks) ||
      typeof raw.issuer !== 'string' || typeof raw.signature !== 'string') {
    reasons.push('ATTESTATION_MALFORMED');
    return { checks, verified };
  }
  if (raw.issuer !== p.issuer) reasons.push('ATTESTATION_ISSUER_MISMATCH');
  if (raw.baseSha !== p.base || raw.targetSha !== p.target || raw.subjectSha !== p.candidate) {
    reasons.push('ATTESTATION_COMMIT_MISMATCH');
  }
  const used = new Set();
  for (const c of raw.checks) {
    if (!c || typeof c !== 'object' || !ID.test(c.id ?? '') ||
        used.has(c.id) || !['PASS', 'FAIL', 'BLOCKED', 'SKIP'].includes(c.status) ||
        (c.evidenceSha256 != null && !DIGEST.test(c.evidenceSha256)) ||
        (c.status === 'PASS' && !DIGEST.test(c.evidenceSha256 ?? ''))) {
      reasons.push('INVALID_CHECK_ATTESTATION');
      continue;
    }
    used.add(c.id);
    checks.push({ id: c.id, status: c.status, evidenceSha256: c.evidenceSha256 ?? null });
  }
  checks.sort((a, b) => a.id.localeCompare(b.id));
  for (const id of p.required) {
    const check = checks.find(c => c.id === id);
    if (!check) reasons.push('MISSING_CHECK:' + id);
    else if (check.status !== 'PASS') reasons.push('CHECK_NOT_PASSED:' + id);
  }
  if (!reasons.includes('INVALID_CHECK_ATTESTATION')) {
    try {
      // The PEM must be provisioned by the operator outside the untrusted checkout.
      const key = createPublicKey(readFileSync(resolve(p.trustedKey), 'utf8'));
      if (key.asymmetricKeyType !== 'ed25519') throw new Error('Unexpected key type');
      if (!/^[A-Za-z0-9+/]{86}==$/.test(raw.signature)) throw new Error('Invalid signature');
      verified = verify(null, Buffer.from(canonicalAttestation(raw)), key, Buffer.from(raw.signature, 'base64'));
    } catch { verified = false; }
  }
  if (!verified) reasons.push('ATTESTATION_SIGNATURE_INVALID');
  return { checks, verified };
}

export function evaluate(p) {
  const repo = resolve(p.repo), reasons = [];
  if (!Array.isArray(p.required) || !p.required.length) reasons.push('REQUIRED_CHECKS_EMPTY');
  if (p.trustedKey && isInside(repo, p.trustedKey)) reasons.push('UNTRUSTED_KEY_LOCATION');
  if (p.checks && isInside(repo, p.checks)) reasons.push('UNTRUSTED_ATTESTATION_LOCATION');
  for (const name of ['base', 'target', 'candidate']) {
    if (!commitExists(repo, p[name])) reasons.push('INVALID_' + name.toUpperCase() + '_COMMIT');
  }
  let observedTargetSha = null;
  try { observedTargetSha = git(repo, 'rev-parse', '--verify', p.targetRef + '^{commit}'); }
  catch { reasons.push('TARGET_REF_UNAVAILABLE'); }
  if (observedTargetSha !== null && observedTargetSha !== p.target) reasons.push('TARGET_REF_MOVED');
  for (const name of ['target', 'candidate']) {
    if (commitExists(repo, p.base) && commitExists(repo, p[name])) {
      if (attempt(repo, 'merge-base', '--is-ancestor', p.base, p[name]).status !== 0) {
        reasons.push('BASE_NOT_ANCESTOR_OF_' + name.toUpperCase());
      }
    }
  }
  let raw = null;
  try { raw = JSON.parse(readFileSync(resolve(p.checks), 'utf8')); }
  catch { reasons.push('CHECKS_FILE_UNAVAILABLE'); }
  const { checks, verified } = inspectAttestation(raw, p, reasons);
  if (!p.evidenceDir) reasons.push('EVIDENCE_DIR_REQUIRED');
  else if (isInside(repo, p.evidenceDir)) reasons.push('EVIDENCE_UNTRUSTED_LOCATION');
  else for (const check of checks) {
    if (!check.evidenceSha256) continue;
    try {
      if (evidenceDigest(p.evidenceDir, check.id) !== check.evidenceSha256) {
        reasons.push('EVIDENCE_MISMATCH:' + check.id);
      }
    } catch {
      reasons.push('EVIDENCE_UNAVAILABLE:' + check.id);
    }
  }
  let candidatePaths = [], targetPaths = [];
  let mergeSimulation = { state: 'NOT_RUN', treeSha: null };
  if (!reasons.some(x => x.startsWith('INVALID_') || x.startsWith('BASE_NOT_ANCESTOR'))) {
    try {
      candidatePaths = changedPaths(repo, p.base, p.candidate);
      targetPaths = changedPaths(repo, p.base, p.target);
      if (git(repo, 'merge-base', p.target, p.candidate) !== p.base) reasons.push('BASE_NOT_ACTUAL_MERGE_BASE');
      const merge = attempt(repo, 'merge-tree', '--write-tree', '--no-messages', p.target, p.candidate);
      const tree = merge.stdout?.trim().split(/\s+/)[0];
      if (!merge.error && [0, 1].includes(merge.status) && SHA.test(tree ?? '')) {
        mergeSimulation = { state: merge.status === 0 ? 'CLEAN' : 'CONFLICT', treeSha: merge.status === 0 ? tree : null };
      } else mergeSimulation = { state: 'UNAVAILABLE', treeSha: null };
      if (mergeSimulation.state === 'CLEAN' &&
          mergeSimulation.treeSha === git(repo, 'rev-parse', p.target + '^{tree}')) {
        reasons.push('CANDIDATE_NO_EFFECTIVE_CHANGE');
      }
    } catch { reasons.push('GIT_PROOF_UNAVAILABLE'); }
  }
  if (!candidatePaths.length) reasons.push('CANDIDATE_NO_CHANGES');
  if (mergeSimulation.state === 'CONFLICT') reasons.push('GIT_MERGE_CONFLICT');
  if (['NOT_RUN', 'UNAVAILABLE'].includes(mergeSimulation.state)) reasons.push('MERGE_PROOF_UNAVAILABLE');
  try {
    if (git(repo, 'rev-parse', '--verify', p.targetRef + '^{commit}') !== p.target) reasons.push('TARGET_REF_MOVED');
  } catch { reasons.push('TARGET_REF_UNAVAILABLE'); }
  const finalReasons = [...new Set(reasons)].sort();
  const receipt = {
    schemaVersion: 2, authority: 'gitflare-forge-gate',
    baseSha: p.base, targetSha: p.target, candidateSha: p.candidate,
    targetRef: p.targetRef, observedTargetSha,
    requiredChecks: [...p.required].sort(), checks,
    attestation: { issuer: p.issuer, verified, signatureAlgorithm: 'ed25519' },
    candidatePaths, targetPaths,
    overlapPaths: candidatePaths.filter(x => targetPaths.includes(x)),
    mergeSimulation,
    verdict: finalReasons.length ? 'BLOCKED' : 'READY_FOR_HUMAN_REVIEW',
    reasons: finalReasons,
    note: 'Review verdict only: no refs updated. Re-run against remote target at integration time.',
  };
  return { ...receipt, receiptSha256: digest(JSON.stringify(receipt)) };
}

export function main(argv) {
  try {
    const flags = { '--repo': 'repo', '--base': 'base', '--target': 'target',
      '--candidate': 'candidate', '--target-ref': 'targetRef',
      '--checks': 'checks', '--trusted-key': 'trustedKey', '--evidence-dir': 'evidenceDir',
      '--issuer': 'issuer', '--out': 'out', '--require-check': 'required' };
    const p = { required: [] };
    for (let i = 0; i < argv.length; i += 2) {
      const key = flags[argv[i]];
      if (!key || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Invalid argument: ' + argv[i]);
      if (key === 'required') p.required.push(argv[i + 1]);
      else if (p[key] !== undefined) throw new Error('Repeated argument: ' + argv[i]);
      else p[key] = argv[i + 1];
    }
    for (const key of ['repo', 'base', 'target', 'candidate', 'targetRef', 'checks', 'trustedKey', 'issuer', 'evidenceDir']) {
      if (!p[key]) throw new Error('Missing ' + key);
    }
    if (!p.required.length || p.required.some(x => !ID.test(x)) ||
        new Set(p.required).size !== p.required.length || !ID.test(p.issuer)) throw new Error('Invalid check/issuer policy');
    for (const key of ['base', 'target', 'candidate']) if (!SHA.test(p[key])) throw new Error('Invalid commit SHA');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(p.targetRef) ||
        p.targetRef.includes('..') || p.targetRef.includes('@{') ||
        p.targetRef.endsWith('.lock')) throw new Error('Invalid target ref');
    const receipt = evaluate(p);
    const output = JSON.stringify(receipt, null, 2) + '\n';
    if (p.out) writeFileSync(resolve(p.out), output, { mode: 0o600 }); else process.stdout.write(output);
    return receipt.verdict === 'READY_FOR_HUMAN_REVIEW' ? 0 : 2;
  } catch (e) {
    process.stderr.write('forge-gate: ' + (e instanceof Error ? e.message : 'unknown error') + '\n');
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  process.exitCode = main(process.argv.slice(2));
}
