import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { produceProof } from '../scripts/forge-prove.mjs';
import { evaluate } from '../scripts/forge-gate.mjs';
const git = (repo, ...args) => execFileSync('git', ['-C',repo,...args], {encoding:'utf8'}).trim();
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'forge-prove-')), repo = join(root,'candidate');
  const evidenceDir = join(root,'evidence'), privateKey = join(root,'ci-key.pem'), publicKey = join(root,'ci-public.pem');
  execFileSync('git',['init','-q','-b','main',repo]);
  git(repo,'config','user.name','test'); git(repo,'config','user.email','test@example.invalid');
  writeFileSync(join(repo,'base.txt'),'initial\n'); git(repo,'add','.'); git(repo,'commit','-qm','initial');
  const base = git(repo,'rev-parse','HEAD');
  git(repo,'switch','-qc','candidate');
  writeFileSync(join(repo,'app.txt'),'safe\n'); git(repo,'add','.'); git(repo,'commit','-qm','candidate');
  const candidate = git(repo,'rev-parse','HEAD'); git(repo,'switch','-q','main');
  writeFileSync(join(repo,'other.txt'),'other\n'); git(repo,'add','.'); git(repo,'commit','-qm','target');
  const target = git(repo,'rev-parse','HEAD');
  const keys=generateKeyPairSync('ed25519');
  writeFileSync(privateKey, keys.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600}); chmodSync(privateKey,0o600);
  writeFileSync(publicKey, keys.publicKey.export({type:'spki',format:'pem'}));
  return {root,repo,evidenceDir,privateKey,publicKey,base,target,candidate,issuer:'gitflare-ci',cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
test('trusted fixed Git checks are signed and accepted by the gate', () => {
  const f=fixture(); try {
    const proof=produceProof(f);
    assert.equal(proof.verdict,'CHECKS_PASS');
    assert.deepEqual(proof.attestation.checks.map(c=>c.id),['git-fsck','diff-check']);
    const result=evaluate({...f,checks:proof.outfile,trustedKey:f.publicKey,targetRef:'main',required:['git-fsck','diff-check']});
    assert.equal(result.verdict,'READY_FOR_HUMAN_REVIEW');
    assert.equal(result.attestation.verified,true);
    writeFileSync(join(f.evidenceDir,'git-fsck.log'),'new, untrusted output');
    assert.ok(evaluate({...f,checks:proof.outfile,trustedKey:f.publicKey,targetRef:'main',required:['git-fsck','diff-check']}).reasons.includes('EVIDENCE_MISMATCH:git-fsck'));
  } finally {f.cleanup();}
});
test('whitespace errors yield a signed FAIL; the gate blocks them', () => {
  const f=fixture(); try {
    git(f.repo,'switch','-q','candidate');
    writeFileSync(join(f.repo,'app.txt'),'invalid whitespace   \n'); git(f.repo,'commit','-qam','bad diff');
    const candidate=git(f.repo,'rev-parse','HEAD'); git(f.repo,'switch','-q','main');
    const proof=produceProof({...f,candidate});
    assert.equal(proof.verdict,'CHECKS_FAILED');
    assert.equal(proof.attestation.checks.find(c=>c.id==='diff-check').status,'FAIL');
    const result=evaluate({...f,candidate,checks:proof.outfile,trustedKey:f.publicKey,targetRef:'main',required:['git-fsck','diff-check']});
    assert.ok(result.reasons.includes('CHECK_NOT_PASSED:diff-check'));
  } finally {f.cleanup();}
});
test('signer rejects a private key inside the untrusted repository', () => {
  const f=fixture(); try {
    const inside=join(f.repo,'bad-key.pem');
    writeFileSync(inside,readFileSync(f.privateKey),{mode:0o600});
    assert.throws(()=>produceProof({...f,privateKey:inside}),/outside the checkout/);
  } finally {f.cleanup();}
});
test('signer refuses to reuse an evidence directory', () => {
  const f=fixture(); try {
    produceProof(f);
    assert.throws(()=>produceProof(f),/EEXIST/);
  } finally {f.cleanup();}
});
