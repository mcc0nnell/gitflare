#!/usr/bin/env node
/** Read-only remote target check. Does not provide atomic merge approval or advance refs. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isInside } from './forge-evidence.mjs';

const SHA = /^[0-9a-f]{40}$/;
const REF = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const checksum = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function preflight(p) {
  const repo = resolve(p.repo), receiptPath = resolve(p.receipt);
  const reasons = [];
  if (isInside(repo, receiptPath)) reasons.push('UNTRUSTED_RECEIPT_LOCATION');
  if (!REF.test(p.remoteRef ?? '') || p.remoteRef.includes('..') || p.remoteRef.includes('@{') ||
      p.remoteRef.endsWith('.lock') || p.remoteRef.endsWith('/')) reasons.push('INVALID_REMOTE_REF');
  if (!p.remote || p.remote.startsWith('-') || /[\r\n\0]/.test(p.remote)) reasons.push('INVALID_REMOTE');
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw Error('bad receipt');
    const { receiptSha256, ...data } = receipt;
    if (!SHA.test(receipt.targetSha ?? '') || !/^[a-f0-9]{64}$/.test(receiptSha256 ?? '') ||
        receiptSha256 !== checksum(data)) reasons.push('RECEIPT_CHECKSUM_INVALID');
    if (receipt.verdict !== 'READY_FOR_HUMAN_REVIEW') reasons.push('REVIEW_NOT_READY');
    if (receipt.targetRef !== p.reviewRef) reasons.push('REVIEW_TARGET_REF_MISMATCH');
  } catch { reasons.push('RECEIPT_UNAVAILABLE'); }
  let observedSha = null;
  if (!reasons.length) {
    const result = spawnSync('git', ['-C', repo, 'ls-remote', '--refs', '--exit-code', p.remote, p.remoteRef], {
      encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['ignore','pipe','pipe'], maxBuffer: 1024 * 1024, timeout: 15000,
    });
    const lines = result.stdout?.trim().split('\n').filter(Boolean) ?? [];
    const matches = lines.map(line => line.split('\t')).filter(x => x.length === 2 && x[1] === p.remoteRef && SHA.test(x[0]));
    if (result.error || result.status !== 0 || matches.length !== 1) reasons.push('REMOTE_REF_UNAVAILABLE');
    else observedSha = matches[0][0];
  }
  if (observedSha && observedSha !== receipt.targetSha) reasons.push('REMOTE_TARGET_MOVED');
  return {
    schemaVersion: 1, operation: 'read-only-preflight',
    verdict: reasons.length ? 'BLOCKED' : 'TARGET_UNCHANGED',
    remoteRef: p.remoteRef, reviewedTargetSha: receipt?.targetSha ?? null,
    observedTargetSha: observedSha, reasons,
    note: 'Not an integration lease. A writer must still perform atomic expected-ref validation at push and verify the result.',
  };
}

export function main(args) {
  try {
    const props = { '--repo':'repo','--receipt':'receipt','--remote':'remote',
      '--remote-ref':'remoteRef','--review-ref':'reviewRef' }, p = {};
    for (let i=0;i<args.length;i+=2) {
      const k=props[args[i]];
      if (!k || !args[i+1] || Object.hasOwn(p,k)) throw new Error('Invalid arguments');
      p[k]=args[i+1];
    }
    if (Object.keys(p).length !== Object.keys(props).length) throw new Error('Missing arguments');
    const result = preflight(p);
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
    return result.verdict === 'TARGET_UNCHANGED' ? 0 : 2;
  } catch (e) {
    process.stderr.write('forge-preflight: '+(e instanceof Error ? e.message : 'invalid input')+'\n');
    return 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  process.exitCode = main(process.argv.slice(2));
}
