import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluate, main, canonicalAttestation } from '../scripts/forge-gate.mjs';

const EVIDENCE = 'a'.repeat(64);
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'forge-v2-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'test'); git(repo, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(repo, 'a'), 'a0\n'); writeFileSync(join(repo, 'b'), 'b0\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'switch', '-qc', 'candidate');
  writeFileSync(join(repo, 'a'), 'a1\n'); git(repo, 'commit', '-qam', 'agent');
  const candidate = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'switch', '-q', 'main');
  writeFileSync(join(repo, 'b'), 'b1\n'); git(repo, 'commit', '-qam', 'target');
  const target = git(repo, 'rev-parse', 'HEAD'), checks = join(repo, 'checks.json'), trustedKey = join(repo, 'key.pem');
  const keys = generateKeyPairSync('ed25519');
  writeFileSync(trustedKey, keys.publicKey.export({ type: 'spki', format: 'pem' }));
  const attest = (overrides = {}) => {
    const raw = { schemaVersion: 2, issuer: 'gitflare-ci', baseSha: base, targetSha: target,
      subjectSha: candidate, checks: [{ id: 'test', status: 'PASS', evidenceSha256: EVIDENCE }], ...overrides };
    raw.signature = sign(null, Buffer.from(canonicalAttestation(raw)), keys.privateKey).toString('base64');
    writeFileSync(checks, JSON.stringify(raw));
    return raw;
  };
  attest();
  return { repo, base, target, candidate, checks, trustedKey, attest,
    p: () => ({ repo, base, target, candidate, checks, trustedKey, issuer: 'gitflare-ci', targetRef: 'main', required: ['test'] }),
    cleanup: () => rmSync(repo, { recursive: true, force: true }) };
}
test('clean disjoint commits yield stable receipt and never advance main', () => {
  const f = fixture(); try {
    const a = evaluate(f.p()), b = evaluate(f.p());
    assert.equal(a.verdict, 'READY_FOR_HUMAN_REVIEW');
    assert.equal(a.attestation.verified, true);
    assert.equal(a.receiptSha256, b.receiptSha256);
    assert.equal(git(f.repo, 'rev-parse', 'main'), f.target);
  } finally { f.cleanup(); }
});
test('conflicting edits block without updating main', () => {
  const f = fixture(); try {
    writeFileSync(join(f.repo, 'a'), 'collision\n'); git(f.repo, 'commit', '-qam', 'collision');
    const target = git(f.repo, 'rev-parse', 'main'); f.attest({ targetSha: target });
    const result = evaluate({ ...f.p(), target });
    assert.ok(result.reasons.includes('GIT_MERGE_CONFLICT'));
    assert.equal(git(f.repo, 'rev-parse', 'main'), target);
  } finally { f.cleanup(); }
});
test('target drift blocks even a correctly signed old attestation', () => {
  const f = fixture(); try {
    writeFileSync(join(f.repo, 'b'), 'drift\n'); git(f.repo, 'commit', '-qam', 'drift');
    assert.ok(evaluate(f.p()).reasons.includes('TARGET_REF_MOVED'));
  } finally { f.cleanup(); }
});
test('tampered PASS evidence fails cryptographic verification', () => {
  const f = fixture(); try {
    const raw = JSON.parse(readFileSync(f.checks, 'utf8')); raw.checks[0].evidenceSha256 = 'b'.repeat(64);
    writeFileSync(f.checks, JSON.stringify(raw));
    assert.ok(evaluate(f.p()).reasons.includes('ATTESTATION_SIGNATURE_INVALID'));
  } finally { f.cleanup(); }
});
test('checks for wrong revision and issuer fail closed', () => {
  const f = fixture(); try {
    f.attest({ targetSha: f.base });
    assert.ok(evaluate(f.p()).reasons.includes('ATTESTATION_COMMIT_MISMATCH'));
    f.attest({ issuer: 'rogue' });
    assert.ok(evaluate(f.p()).reasons.includes('ATTESTATION_ISSUER_MISMATCH'));
  } finally { f.cleanup(); }
});
test('missing key or skipped/missing test never pass', () => {
  const f = fixture(); try {
    assert.ok(evaluate({ ...f.p(), trustedKey: join(f.repo, 'absent.pem') }).reasons.includes('ATTESTATION_SIGNATURE_INVALID'));
    f.attest({ checks: [{ id: 'test', status: 'SKIP' }] });
    assert.ok(evaluate(f.p()).reasons.includes('CHECK_NOT_PASSED:test'));
    f.attest({ checks: [] });
    assert.ok(evaluate(f.p()).reasons.includes('MISSING_CHECK:test'));
  } finally { f.cleanup(); }
});
test('no-change candidate and invalid ancestry block', () => {
  const f = fixture(); try {
    assert.ok(evaluate({ ...f.p(), candidate: f.base }).reasons.includes('CANDIDATE_NO_CHANGES'));
    assert.equal(evaluate({ ...f.p(), base: '0'.repeat(40) }).verdict, 'BLOCKED');
  } finally { f.cleanup(); }
});
test('CLI requires signing authority and rejects malformed arguments', () => {
  const f = fixture(); try {
    assert.equal(main(['--repo', f.repo]), 1);
    assert.equal(main(['--repo', f.repo, '--base', f.base, '--target', f.target, '--candidate', f.candidate,
      '--target-ref', 'main', '--checks', f.checks, '--issuer', 'gitflare-ci', '--trusted-key', f.trustedKey,
      '--require-check', 'test', '--out', join(f.repo, 'receipt.json')]), 0);
    assert.equal(main(['--repo', f.repo, '--base', f.base, '--target', f.target, '--candidate', f.candidate,
      '--target-ref', '-evil', '--checks', f.checks, '--issuer', 'gitflare-ci', '--trusted-key', f.trustedKey,
      '--require-check', 'test']), 1);
  } finally { f.cleanup(); }
});

test('candidate already represented in target tree is not a meaningful merge', () => {
  const f = fixture(); try {
    writeFileSync(join(f.repo, 'a'), 'a1\n'); git(f.repo, 'commit', '-qam', 'same content as agent');
    const target = git(f.repo, 'rev-parse', 'main'); f.attest({ targetSha: target });
    const result = evaluate({ ...f.p(), target });
    assert.ok(result.reasons.includes('CANDIDATE_NO_EFFECTIVE_CHANGE'));
  } finally { f.cleanup(); }
});
