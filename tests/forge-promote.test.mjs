import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { produceProof } from '../scripts/forge-prove.mjs';
import { evaluate } from '../scripts/forge-gate.mjs';
import { promote, pushWithLease } from '../scripts/forge-promote.mjs';
const git=(repo,...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'forge-promote-')),repo=join(root,'repo'),remote=join(root,'remote.git');
  execFileSync('git',['init','--bare','-q',remote]);execFileSync('git',['init','-q','-b','main',repo]);
  git(repo,'config','user.email','test@example.invalid');git(repo,'config','user.name','test');
  writeFileSync(join(repo,'src'),'base\n');git(repo,'add','.');git(repo,'commit','-qm','base');
  const base=git(repo,'rev-parse','HEAD');git(repo,'push','-q',remote,'HEAD:refs/heads/main');
  git(repo,'switch','-qc','candidate');writeFileSync(join(repo,'src'),'candidate\n');
  git(repo,'commit','-qam','candidate');const candidate=git(repo,'rev-parse','HEAD');git(repo,'switch','-q','main');
  const keys=generateKeyPairSync('ed25519'),privateKey=join(root,'key.pem'),trustedKey=join(root,'pub.pem');
  writeFileSync(privateKey,keys.privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600});chmodSync(privateKey,0o600);
  writeFileSync(trustedKey,keys.publicKey.export({format:'pem',type:'spki'}));
  const evidenceDir=join(root,'evidence'),issuer='gitflare-ci',target=base,targetRef='main',remoteRef='refs/heads/main';
  const proof=produceProof({repo,base,target,candidate,issuer,privateKey,evidenceDir});
  const args={repo,base,target,candidate,issuer,trustedKey,evidenceDir,remote,remoteRef,targetRef,
    checks:proof.outfile,required:['git-fsck','diff-check']};
  const record=evaluate(args);assert.equal(record.verdict,'READY_FOR_HUMAN_REVIEW');
  const receipt=join(evidenceDir,'review.json');writeFileSync(receipt,JSON.stringify(record));
  return {root,repo,remote,receipt,record,candidate,target,args:{...args,receipt},cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
test('promotion is read-only by default and shows exact approved receipt',()=>{
  const f=fixture();try{
    const r=promote(f.args);
    assert.equal(r.verdict,'PREPARED_ONLY');
    assert.equal(r.reviewedReceiptSha256,f.record.receiptSha256);
    assert.equal(git(f.remote,'rev-parse','refs/heads/main'),f.target);
  }finally{f.cleanup();}
});
test('explicit digest approval permits verified fast-forward integration',()=>{
  const f=fixture();try{
    const r=promote({...f.args,execute:true,approve:f.record.receiptSha256});
    assert.equal(r.verdict,'INTEGRATED_AND_VERIFIED');
    assert.equal(git(f.remote,'rev-parse','refs/heads/main'),f.candidate);
    assert.equal(promote({...f.args,execute:true,approve:f.record.receiptSha256}).verdict,'BLOCKED');
  }finally{f.cleanup();}
});
test('missing or invalid approval cannot mutate the remote',()=>{
  const f=fixture();try{
    const r=promote({...f.args,execute:true,approve:'0'.repeat(64)});
    assert.ok(r.reasons.includes('EXPLICIT_APPROVAL_REQUIRED'));
    assert.equal(git(f.remote,'rev-parse','refs/heads/main'),f.target);
  }finally{f.cleanup();}
});
test('remote drift blocks review, and the final expected-ref lease independently rejects races',()=>{
  const f=fixture();try{
    const other=join(f.root,'other');execFileSync('git',['clone','-q',f.remote,other]);
    git(other,'config','user.email','other@example.invalid');git(other,'config','user.name','other');
    git(other,'switch','-q','main');writeFileSync(join(other,'race'),'new revision\n');
    git(other,'add','.');git(other,'commit','-qm','other writer');git(other,'push','-q','origin','HEAD:main');
    const moved=git(f.remote,'rev-parse','refs/heads/main');
    assert.ok(promote({...f.args,execute:true,approve:f.record.receiptSha256}).reasons.includes('REMOTE_TARGET_MOVED'));
    assert.equal(pushWithLease({...f.args}), 'REF_UPDATE_REJECTED');
    assert.equal(git(f.remote,'rev-parse','refs/heads/main'),moved);
  }finally{f.cleanup();}
});
