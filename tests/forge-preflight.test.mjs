import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { preflight } from '../scripts/forge-preflight.mjs';
const git = (repo,...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim();
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'forge-preflight-')),repo=join(root,'working'),remote=join(root,'remote.git');
  execFileSync('git',['init','--bare','-q',remote]);
  execFileSync('git',['init','-q','-b','main',repo]);
  git(repo,'config','user.email','test@example.invalid');git(repo,'config','user.name','test');
  writeFileSync(join(repo,'a.txt'),'1\n');git(repo,'add','.');git(repo,'commit','-qm','initial');
  git(repo,'push','-q',remote,'HEAD:refs/heads/main');
  const targetSha=git(repo,'rev-parse','HEAD'), dir=join(root,'operator');
  execFileSync('mkdir',['-p',dir]);
  const receipt=join(dir,'review.json'), document={schemaVersion:2,targetSha, targetRef:'main',verdict:'READY_FOR_HUMAN_REVIEW', reasons:[]};
  document.receiptSha256=createHash('sha256').update(JSON.stringify(document)).digest('hex');
  writeFileSync(receipt,JSON.stringify(document));
  return {repo,remote,receipt,targetSha,p:{repo,remote,receipt,remoteRef:'refs/heads/main',reviewRef:'main'},cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
test('read-only remote preflight confirms pinned revision without mutation',()=>{
  const f=fixture();try{
    const result=preflight(f.p);
    assert.equal(result.verdict,'TARGET_UNCHANGED');
    assert.equal(git(f.remote,'rev-parse','refs/heads/main'),f.targetSha);
  }finally{f.cleanup();}
});
test('remote target drift after review blocks preflight',()=>{
  const f=fixture();try{
    writeFileSync(join(f.repo,'a.txt'),'2\n');git(f.repo,'commit','-qam','drift');git(f.repo,'push','-q',f.remote,'HEAD:refs/heads/main');
    const r=preflight(f.p);
    assert.equal(r.verdict,'BLOCKED');
    assert.ok(r.reasons.includes('REMOTE_TARGET_MOVED'));
  }finally{f.cleanup();}
});
test('tampered digest or untrusted receipt location blocks',()=>{
  const f=fixture();try{
    const bad=JSON.parse((awaitRead(f.receipt)));bad.verdict='BLOCKED';writeFileSync(f.receipt,JSON.stringify(bad));
    assert.ok(preflight(f.p).reasons.includes('RECEIPT_CHECKSUM_INVALID'));
    assert.ok(preflight({...f.p,receipt:join(f.repo,'review.json')}).reasons.includes('UNTRUSTED_RECEIPT_LOCATION'));
  }finally{f.cleanup();}
});
function awaitRead(file){ return execFileSync('cat',[file],{encoding:'utf8'}); }
