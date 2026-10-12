#!/usr/bin/env node
/** Manual fast-forward-only promotion. Preview by default; writes require exact receipt approval. */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { evaluate } from './forge-gate.mjs';
import { preflight } from './forge-preflight.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });
function runPush(repo, remote, ref, oldSha, newSha) {
  const result=spawnSync('git', ['-c','core.hooksPath=/dev/null','-C',resolve(repo),
    'push','--porcelain',`--force-with-lease=${ref}:${oldSha}`, remote,`${newSha}:${ref}`], {
    env:gitEnv(),encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:1024*1024,timeout:30000,
  });
  return !result.error && result.status===0;
}
export function pushWithLease(p) {
  const ancestry = spawnSync('git', ['-C', resolve(p.repo), 'merge-base', '--is-ancestor', p.target, p.candidate], {
    env: gitEnv(), stdio: 'ignore', timeout: 15000,
  });
  if (ancestry.error || ancestry.status !== 0) return 'NON_FAST_FORWARD_CANDIDATE';
  if (!runPush(p.repo,p.remote,p.remoteRef,p.target,p.candidate)) return 'REF_UPDATE_REJECTED';
  const remote=preflightRemote(p.repo,p.remote,p.remoteRef);
  return remote === p.candidate ? 'INTEGRATED_AND_VERIFIED' : 'INTEGRATION_UNVERIFIED';
}
function preflightRemote(repo, remote, ref) {
  const result=spawnSync('git',['-C',resolve(repo),'ls-remote','--refs','--exit-code',remote,ref],{
    env:gitEnv(),encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:15000,maxBuffer:1024*1024,
  });
  if (result.error || result.status!==0) return null;
  const rows=result.stdout.trim().split('\n').map(line=>line.split('\t'));
  const hits=rows.filter(row=>row.length===2 && row[1]===ref && /^[a-f0-9]{40}$/.test(row[0]));
  return hits.length===1 ? hits[0][0] : null;
}
export function promote(p) {
  const reasons=[];
  let review;
  try { review=evaluate(p); }
  catch { return { verdict:'BLOCKED',reasons:['REVIEW_CHECK_FAILED'] }; }
  if (review.verdict!=='READY_FOR_HUMAN_REVIEW') reasons.push('REVIEW_NOT_READY');
  let stored;
  try { stored=JSON.parse(readFileSync(resolve(p.receipt),'utf8')); }
  catch { reasons.push('REVIEW_RECEIPT_UNAVAILABLE'); }
  if (stored?.receiptSha256!==review.receiptSha256) reasons.push('REVIEW_RECEIPT_CHANGED');
  if (p.execute && (!SHA256.test(p.approve??'') || p.approve!==review.receiptSha256)) {
    reasons.push('EXPLICIT_APPROVAL_REQUIRED');
  }
  const isDescendant=spawnSync('git',['-C',resolve(p.repo),'merge-base','--is-ancestor',p.target,p.candidate],{
    env:gitEnv(),stdio:'ignore',timeout:15000,
  }).status===0;
  if (!isDescendant) reasons.push('NON_FAST_FORWARD_CANDIDATE');
  const remote=preflight({...p, reviewRef:p.targetRef});
  if (remote.verdict!=='TARGET_UNCHANGED') reasons.push(...remote.reasons);
  if (reasons.length) return { verdict:'BLOCKED', reasons:[...new Set(reasons)].sort(), reviewedReceiptSha256:review.receiptSha256 };
  if (!p.execute) return {
    verdict:'PREPARED_ONLY',reviewedReceiptSha256:review.receiptSha256,
    expectedRemoteSha:p.target,candidateSha:p.candidate,
    note:'No push performed. To integrate, run again with --execute and --approve <receipt digest> as an authorized operator.',
  };
  const verdict=pushWithLease(p);
  return { verdict,reasons:verdict==='INTEGRATED_AND_VERIFIED'?[]:[verdict],
    reviewedReceiptSha256:review.receiptSha256,expectedRemoteSha:p.target,candidateSha:p.candidate };
}
export function main(argv) {
  try {
    const flags={'--repo':'repo','--base':'base','--target':'target','--candidate':'candidate',
      '--target-ref':'targetRef','--remote':'remote','--remote-ref':'remoteRef',
      '--receipt':'receipt','--checks':'checks','--evidence-dir':'evidenceDir',
      '--trusted-key':'trustedKey','--issuer':'issuer','--require-check':'required','--approve':'approve'};
    const p={required:[],execute:false};
    for(let i=0;i<argv.length;i++){
      if(argv[i]==='--execute'){if(p.execute)throw Error('Repeated execute');p.execute=true;continue;}
      const key=flags[argv[i]];
      if(!key || !argv[i+1] || argv[i+1].startsWith('--'))throw Error('Invalid flag');
      if(key==='required')p.required.push(argv[++i]);
      else if(Object.hasOwn(p,key))throw Error('Repeated option');
      else p[key]=argv[++i];
    }
    for(const key of ['repo','base','target','candidate','targetRef','remote','remoteRef','receipt','checks','evidenceDir','trustedKey','issuer']){
      if(!p[key])throw Error('Missing '+key);
    }
    if(!p.required.length)throw Error('At least one required check is mandatory');
    const r=promote(p);
    process.stdout.write(JSON.stringify(r,null,2)+'\n');
    return r.verdict==='PREPARED_ONLY'||r.verdict==='INTEGRATED_AND_VERIFIED'?0:2;
  }catch(error){process.stderr.write('forge-promote: '+(error instanceof Error?error.message:'invalid input')+'\n');return 1;}
}
if(process.argv[1] && resolve(process.argv[1])===resolve(new URL(import.meta.url).pathname)){
  process.exitCode=main(process.argv.slice(2));
}
