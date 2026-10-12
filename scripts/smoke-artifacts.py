#!/usr/bin/env python3
"""Opt-in live Artifacts concurrency smoke; creates and deletes real Cloudflare resources."""
import json, os, pathlib, secrets, shutil, signal, subprocess, sys, tempfile, time, urllib.request
if '--yes-create-disposable-artifacts' not in sys.argv:
    raise SystemExit('Explicit consent required: python3 scripts/smoke-artifacts.py --yes-create-disposable-artifacts')
root=pathlib.Path(tempfile.mkdtemp(prefix='forge-live-'))
project=pathlib.Path(__file__).resolve().parents[1]
wrangler=str(project/'node_modules/.bin/wrangler')
name='forge-agents-'+secrets.token_hex(3)
admin=secrets.token_urlsafe(32)
created=[]
server=None
dev_vars=project/'.dev.vars'
assert not dev_vars.exists(), 'Existing secret file must not be touched'
def run(argv,cwd=None,env=None,timeout=55,expected=0):
    r=subprocess.run([str(x) for x in argv],cwd=str(cwd or project),env=env,capture_output=True,text=True,timeout=timeout)
    if r.returncode!=expected:
        raise RuntimeError('command '+str(argv[:3])+' returned '+str(r.returncode))
    return r.stdout.strip()
def git(directory,*args,token=None,remote=None):
    env=os.environ.copy(); env.update({'GIT_TERMINAL_PROMPT':'0','GIT_OPTIONAL_LOCKS':'0'})
    if token:
        env.update({'GIT_CONFIG_COUNT':'1','GIT_CONFIG_KEY_0':'http.extraHeader','GIT_CONFIG_VALUE_0':'Authorization: Bearer '+token})
    return run(['git','-C',directory,*args],env=env)
def readjson(url,body=None):
    headers={'authorization':'Bearer '+admin,'content-type':'application/json'}
    req=urllib.request.Request(url,data=json.dumps(body).encode() if body is not None else None,headers=headers,method='POST' if body is not None else 'GET')
    with urllib.request.urlopen(req,timeout=20) as r:
        return json.load(r)
def phase(label): print('PHASE: '+label,flush=True)
try:
    phase('create disposable canonical Artifacts repository')
    source=json.loads(run([wrangler,'artifacts','repos','create',name,'--namespace','gitflare','--default-branch','main','--json']))
    created.append(name)
    src=root/'source';src.mkdir()
    run(['git','init','-q','-b','main',str(src)])
    git(src,'config','user.name','Forge Live Test');git(src,'config','user.email','forge@example.invalid')
    (src/'parser.txt').write_text('base parser\n');(src/'docs.txt').write_text('base docs\n')
    git(src,'add','.');git(src,'commit','-qm','seed shared base')
    base=git(src,'rev-parse','HEAD')
    git(src,'push','--quiet',source['remote'],'HEAD:refs/heads/main',token=source['token'])
    phase('boot local Worker with remote Artifacts binding')
    dev_vars.write_text('GITFLARE_ADMIN_TOKEN="'+admin+'"\n');dev_vars.chmod(0o600)
    logfile=open(root/'server.log','w')
    server=subprocess.Popen([wrangler,'dev','--ip','127.0.0.1','--port','8794'],cwd=project,stdout=logfile,stderr=subprocess.STDOUT,start_new_session=True)
    for i in range(30):
        try:
            with urllib.request.urlopen('http://127.0.0.1:8794/healthz',timeout=2) as r:
                if r.status==200: break
        except Exception:time.sleep(1)
    else:raise RuntimeError('Worker not ready')
    phase('create three isolated agent forks')
    names={}
    for agent in ['a','b','c']:
        r=readjson('http://127.0.0.1:8794/repos/'+name+'/forks',{'label':'agent '+agent+' concurrency smoke'})
        names[agent]=r;created.append(r['fork'])
    phase('three clients clone, commit and push independently')
    commits={}
    for agent in ['a','b','c']:
        item=names[agent]; clone=root/('agent-'+agent)
        for attempt in range(9):
            r=subprocess.run(['git','clone','--quiet',item['remote'],str(clone)],
                env={**os.environ,'GIT_TERMINAL_PROMPT':'0','GIT_CONFIG_COUNT':'1','GIT_CONFIG_KEY_0':'http.extraHeader','GIT_CONFIG_VALUE_0':'Authorization: Bearer '+item['initialToken']},
                stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=25)
            if r.returncode==0:break
            time.sleep(2)
        else:raise RuntimeError('fork clone unavailable for '+agent)
        git(clone,'config','user.name','agent-'+agent);git(clone,'config','user.email','agent@example.invalid')
        if agent=='b':(clone/'docs.txt').write_text('independent docs edit\n')
        else:(clone/'parser.txt').write_text('parser change '+agent+'\n')
        git(clone,'add','.');git(clone,'commit','-qm','agent '+agent+' patch')
        commits[agent]=git(clone,'rev-parse','HEAD')
        git(clone,'push','--quiet',item['remote'],'HEAD:refs/heads/main',token=item['initialToken'])
        git(src,'fetch','--quiet',item['remote'],'refs/heads/main',token=item['initialToken'])
        assert git(src,'rev-parse','FETCH_HEAD')==commits[agent]
        git(src,'update-ref','refs/heads/agent-'+agent,commits[agent])
    phase('generate private CI signer outside all agent checkouts')
    key=root/'signer.pem';public=root/'signer.pub.pem'
    run(['node','-e', 'const {generateKeyPairSync}=require("crypto");const {writeFileSync,chmodSync}=require("fs");let k=generateKeyPairSync("ed25519");writeFileSync(process.argv[1],k.privateKey.export({type:"pkcs8",format:"pem"}));chmodSync(process.argv[1],0o600);writeFileSync(process.argv[2],k.publicKey.export({type:"spki",format:"pem"}));',str(key),str(public)])
    git(src,'update-ref','refs/heads/preview-a',commits['a'])
    results={}
    for agent in ['a','b','c']:
        target=base if agent=='a' else commits['a']
        ref='main' if agent=='a' else 'preview-a'
        evid=root/('evidence-'+agent)
        proof=json.loads(run(['node',str(project/'scripts/forge-prove.mjs'),'--repo',str(src),'--base',base,'--target',target,'--candidate',commits[agent],'--issuer','trusted-fixed-git','--private-key',str(key),'--evidence-dir',str(evid)]))
        argv=['node',str(project/'scripts/forge-gate.mjs'),'--repo',str(src),'--base',base,'--target',target,'--candidate',commits[agent],'--target-ref',ref,'--checks',proof['attestationPath'],'--evidence-dir',str(evid),'--trusted-key',str(public),'--issuer','trusted-fixed-git','--require-check','git-fsck','--require-check','diff-check']
        p=subprocess.run(argv,capture_output=True,text=True,timeout=30)
        if p.returncode not in (0,2):raise RuntimeError('gate failed to run '+agent)
        receipt=json.loads(p.stdout); (evid/'review.json').write_text(json.dumps(receipt))
        results[agent]={'verdict':receipt['verdict'],'merge':receipt['mergeSimulation']['state'],'reasons':receipt['reasons']}
    phase('verify remote target still pinned; no canonical integration performed')
    pre=json.loads(run(['node',str(project/'scripts/forge-preflight.mjs'),'--repo',str(src),'--receipt',str(root/'evidence-a'/'review.json'),'--remote',source['remote'],'--remote-ref','refs/heads/main','--review-ref','main'],env={**os.environ,'GIT_TERMINAL_PROMPT':'0','GIT_CONFIG_COUNT':'1','GIT_CONFIG_KEY_0':'http.extraHeader','GIT_CONFIG_VALUE_0':'Authorization: Bearer '+source['token']}))
    assert pre['verdict']=='TARGET_UNCHANGED'
    assert git(src,'ls-remote',source['remote'],'refs/heads/main',token=source['token']).split()[0]==base
    assert results['a']['verdict']=='READY_FOR_HUMAN_REVIEW'
    assert results['b']['verdict']=='READY_FOR_HUMAN_REVIEW'
    assert results['c']['verdict']=='BLOCKED' and 'GIT_MERGE_CONFLICT' in results['c']['reasons']
    print('RESULT: '+json.dumps({'source_sha_unchanged':True,'forks':3,'agent_results':results,'remote_preflight':pre['verdict']}),flush=True)
finally:
    phase('cleanup temporary Cloudflare repositories and credentials')
    if server:
        try:os.killpg(server.pid,signal.SIGTERM)
        except ProcessLookupError:pass
        try:server.wait(timeout=4)
        except subprocess.TimeoutExpired:
            os.killpg(server.pid,signal.SIGKILL)
    if dev_vars.exists():dev_vars.unlink()
    cleanup_failed=[]
    for item in reversed(created):
        try:
            out=json.loads(run([wrangler,'artifacts','repos','delete',item,'--namespace','gitflare','--force','--json'],timeout=45))
            print('CLEANED: '+item+'='+str(bool(out.get('deleted'))),flush=True)
        except Exception:
            cleanup_failed.append(item)
            print('CLEANUP_FAILED: '+item,flush=True)
    shutil.rmtree(root,ignore_errors=True)
    if cleanup_failed: raise RuntimeError('Disposable Artifacts cleanup failed: '+','.join(cleanup_failed))
