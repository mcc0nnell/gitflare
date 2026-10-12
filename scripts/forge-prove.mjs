#!/usr/bin/env node
/** Minimal trusted producer for fixed Git checks. NEVER executes candidate test scripts. */
import { createPrivateKey, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { canonicalAttestation } from './forge-gate.mjs';
import { evidenceDigest, isInside } from './forge-evidence.mjs';

const SHA = /^[0-9a-f]{40}$/;
const ID = /^[a-z][a-z0-9_.-]{0,63}$/;
const env = {
  PATH: process.env.PATH || '/usr/bin:/bin',
  HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_COUNT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat', LC_ALL: 'C',
};

function git(repo, ...args) {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=', '-C', repo, ...args], {
    env, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 30_000, stdio: ['ignore','pipe','pipe'],
  });
  if (r.error) return { status: 'BLOCKED', log: String(r.error.message) };
  if (r.status !== 0) return { status: 'FAIL', log: (r.stderr || r.stdout || 'command failed').slice(0, 1024 * 1024) };
  return { status: 'PASS', log: r.stdout || 'Git check succeeded\n' };
}

export function produceProof(p) {
  const repo = resolve(p.repo), evidenceDir = resolve(p.evidenceDir), keyPath = resolve(p.privateKey);
  if (![p.base, p.target, p.candidate].every(s => SHA.test(s ?? '')) || !ID.test(p.issuer ?? '')) {
    throw new Error('Invalid source identity or issuer');
  }
  if (isInside(repo, evidenceDir) || isInside(repo, keyPath) ||
      isInside(evidenceDir, keyPath)) throw new Error('Signing key and evidence must be outside the checkout');
  const keyStat = statSync(keyPath);
  if (!keyStat.isFile() || (keyStat.mode & 0o077) !== 0) throw new Error('Private key must be a regular 0600 file');
  const key = createPrivateKey(readFileSync(keyPath));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Ed25519 key required');
  for (const sha of [p.base, p.target, p.candidate]) {
    const r = git(repo, 'rev-parse', '--verify', sha + '^{commit}');
    if (r.status !== 'PASS' || r.log.trim() !== sha) throw new Error('Missing immutable Git commit');
  }
  mkdirSync(evidenceDir, { mode: 0o700 }); // Must be isolated operator-owned storage.
  const specs = [
    ['git-fsck', ['fsck', '--connectivity-only', '--no-reflogs']],
    ['diff-check', ['diff', '--no-ext-diff', '--no-textconv', '--check', p.base, p.candidate]],
  ];
  const checks = specs.map(([id, args]) => {
    const result = git(repo, ...args);
    writeFileSync(join(evidenceDir, id + '.log'), result.log, { mode: 0o600, flag: 'wx' });
    return { id, status: result.status, evidenceSha256: evidenceDigest(evidenceDir, id) };
  });
  const attestation = {
    schemaVersion: 2, issuer: p.issuer, baseSha: p.base, targetSha: p.target,
    subjectSha: p.candidate, checks,
  };
  attestation.signature = sign(null, Buffer.from(canonicalAttestation(attestation)), key).toString('base64');
  const outfile = resolve(p.out ?? join(evidenceDir, 'attestation.json'));
  if (!isInside(evidenceDir, outfile)) throw new Error('Attestation output must be inside evidence directory');
  writeFileSync(outfile, JSON.stringify(attestation, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return { attestation, outfile, verdict: checks.every(c => c.status === 'PASS') ? 'CHECKS_PASS' : 'CHECKS_FAILED' };
}

export function main(argv) {
  try {
    const allowed = { '--repo':'repo','--base':'base','--target':'target',
      '--candidate':'candidate','--issuer':'issuer','--private-key':'privateKey',
      '--evidence-dir':'evidenceDir','--out':'out' };
    const p = {};
    for (let i = 0; i < argv.length; i += 2) {
      const name = allowed[argv[i]];
      if (!name || !argv[i+1] || Object.hasOwn(p, name)) throw new Error('Invalid option');
      p[name] = argv[i+1];
    }
    for (const k of ['repo','base','target','candidate','issuer','privateKey','evidenceDir']) {
      if (!p[k]) throw new Error('Missing option ' + k);
    }
    const r = produceProof(p);
    process.stdout.write(JSON.stringify({ verdict:r.verdict, attestationPath:r.outfile }) + '\n');
    return r.verdict === 'CHECKS_PASS' ? 0 : 2;
  } catch (e) {
    process.stderr.write('forge-prove: ' + (e instanceof Error ? e.message : 'unknown error') + '\n');
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  process.exitCode = main(process.argv.slice(2));
}
