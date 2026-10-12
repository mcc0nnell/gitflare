/** Forge read-only viewer: local receipt inspection and scoped event polling. No source writes. */
export function forgeConsoleHtml(): string {
  return String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>Gitflare Forge · Evidence Console</title>
<style>
:root{color-scheme:dark;--bg:#0b0f12;--panel:#11191d;--line:#294047;--text:#dcecef;--muted:#92aab2;--cyan:#54d9e6;--green:#7ceb9d;--amber:#ffd36b;--red:#ff8383}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% -5%,#12434b55,transparent 38%),var(--bg);color:var(--text);font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
header,main,footer{max-width:1150px;margin:auto;padding:20px clamp(14px,4vw,32px)}header{border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.brand{font-size:18px;font-weight:750;letter-spacing:.06em;color:var(--cyan)}.brand span{color:var(--text)}.mode{border:1px solid var(--line);border-radius:20px;padding:4px 10px;color:var(--muted);font-size:11px;letter-spacing:.08em}
h1{font-size:clamp(22px,4vw,34px);margin:0 0 8px;line-height:1.2}p{color:var(--muted);margin:5px 0 18px;max-width:850px}
.grid{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(300px,1fr);gap:16px}.panel{border:1px solid var(--line);border-radius:12px;background:var(--panel);padding:20px;min-width:0}.panel h2{font-size:14px;color:var(--cyan);letter-spacing:.08em;margin:0 0 14px;text-transform:uppercase}.panel h3{font-size:13px;margin:18px 0 9px}
.toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:18px 0}.btn,.file-btn{display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--cyan);color:var(--cyan);background:#13323a;border-radius:7px;min-height:42px;padding:9px 12px;font:inherit;cursor:pointer}
.btn.secondary{border-color:var(--line);color:var(--text);background:#182328}.btn:hover,.file-btn:hover,.btn:focus-visible,.file-btn:focus-within{outline:2px solid var(--cyan);outline-offset:2px}.file-btn input{position:absolute;width:1px;height:1px;opacity:0}
.live-form{display:flex;gap:9px;flex-wrap:wrap;align-items:end}.live-form label{display:grid;gap:3px;color:var(--muted);font-size:12px}.live-form input{min-height:42px;border:1px solid var(--line);background:#0b1418;border-radius:6px;padding:8px;color:var(--text);font:inherit;max-width:260px}.events{max-height:280px;overflow:auto}.data{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.datum{padding:12px;background:#0c1417;border:1px solid #24353a;border-radius:8px;min-width:0}.datum small{display:block;color:var(--muted);font-size:11px;text-transform:uppercase}.datum b{font-size:14px;overflow-wrap:anywhere}
.badge{display:inline-block;border-radius:4px;padding:3px 8px;font-weight:700;color:var(--green);border:1px solid currentColor}.badge.blocked{color:var(--red)}.badge.demo{color:var(--amber)}
ul{list-style:none;padding:0;margin:6px 0}li{border-bottom:1px solid #26383e;padding:8px 0;overflow-wrap:anywhere}li:last-child{border-bottom:0}code{color:var(--text);overflow-wrap:anywhere}svg{max-width:100%;width:100%;height:auto;min-height:205px;background:#0b1418;border:1px solid var(--line);border-radius:8px}
#notice{min-height:25px;color:var(--amber)}#graph text{font:12px ui-monospace,monospace;fill:var(--text)}.muted{color:var(--muted)}textarea{width:100%;min-height:90px;resize:vertical;background:#0b1418;color:var(--text);border:1px solid var(--line);border-radius:7px;padding:11px;font:12px/1.4 ui-monospace,monospace}
footer{font-size:12px;color:var(--muted);border-top:1px solid var(--line)}.full{grid-column:1/-1}@media(max-width:810px){.grid{grid-template-columns:1fr}.data{grid-template-columns:1fr 1fr}}
@media(prefers-reduced-motion:reduce){*,*:before,*:after{scroll-behavior:auto!important;animation:none!important;transition:none!important}}
</style>
</head>
<body>
<header><div class="brand">GITFLARE <span>/</span> FORGE</div><div class="mode">LOCAL RECEIPT INSPECTOR · NO GIT WRITE AUTHORITY</div></header>
<main>
<h1>Every change. Every claim. Every receipt.</h1>
<p>Load a Forge review receipt to inspect the commit graph, decision, required checks, evidence digests and conflict reasons. The file stays in your browser. This page has no Cloudflare administration privileges.</p>
<div class="toolbar"><label class="file-btn">[ LOAD RECEIPT ]<input id="file" type="file" accept=".json,application/json" aria-label="Load Forge receipt JSON"></label><button class="btn secondary" id="sample" type="button">[ VIEW SAMPLE ]</button><span id="notice" role="status" aria-live="polite">No receipt loaded</span></div>
<section class="panel" aria-label="Repository event journal" style="margin-bottom:16px">
<h2>Live agent activity / scoped replay</h2>
<div class="live-form">
<label>Repository<input id="live-repo" autocomplete="off" spellcheck="false" placeholder="repository" aria-label="Event repository"></label>
<label>Read capability<input id="live-token" type="password" autocomplete="off" spellcheck="false" placeholder="short-lived token" aria-label="Read-only event capability"></label>
<button class="btn" id="live-connect" type="button">[ FOLLOW EVENTS ]</button>
<button class="btn secondary" id="live-disconnect" type="button">[ DISCONNECT ]</button>
</div><p id="live-status" role="status" aria-live="polite">Not connected. Obtain a repository-scoped, read-only token from an administrator.</p>
<ul class="events" id="live-events" aria-label="Recent agent events"><li class="muted">No events loaded</li></ul>
</section>
<div class="grid">
<section class="panel" aria-label="Review summary"><h2>01 / Review state</h2><div id="state"><span class="muted">Awaiting receipt</span></div><div class="data" style="margin-top:16px"><div class="datum"><small>Target SHA</small><b id="target">—</b></div><div class="datum"><small>Candidate SHA</small><b id="candidate">—</b></div><div class="datum"><small>Checks</small><b id="checks-count">—</b></div><div class="datum"><small>Local checksum</small><b id="checksum">—</b></div></div><h3>Decision reasons</h3><ul id="reasons"><li class="muted">No data</li></ul></section>
<section class="panel" aria-label="Commit graph"><h2>02 / Change graph</h2><svg id="graph" viewBox="0 0 480 235" role="img" aria-label="Commit ancestry diagram"><text x="28" y="115">Load a receipt to see revisions</text></svg><p class="muted" style="margin-top:12px">A clean merge simulation is not a production integration. A target ref must be rechecked before any authorized push.</p></section>
<section class="panel"><h2>03 / Required evidence</h2><ul id="checks"><li class="muted">No checks</li></ul></section>
<section class="panel"><h2>04 / Changed paths</h2><ul id="paths"><li class="muted">No paths</li></ul></section>
<section class="panel full"><h2>05 / Inspect raw receipt</h2><textarea id="json" spellcheck="false" aria-label="Paste Forge receipt JSON" placeholder="Paste a review receipt here, or load a JSON file..."></textarea><div class="toolbar"><button class="btn" id="inspect" type="button">[ INSPECT JSON ]</button><span class="muted">Checksum proves only internal consistency—not who signed CI evidence.</span></div></section>
</div>
</main>
<footer>GITFLARE / FORGE — CLIENT-SIDE VIEWER ONLY · TRUSTED SIGNER, EVIDENCE STORE, AND HUMAN APPROVAL ARE SEPARATE AUTHORITIES</footer>
<script nonce="__FORGE_NONCE__">
(function(){
'use strict';
var NS='http://www.w3.org/2000/svg';
var $=function(id){return document.getElementById(id)};
var sha=/^[0-9a-f]{40}$/,hash=/^[0-9a-f]{64}$/;
function node(tag,attrs,body){var e=document.createElementNS(NS,tag);Object.entries(attrs||{}).forEach(function(a){e.setAttribute(a[0],a[1])});if(body!==undefined)e.textContent=body;return e}
function txt(id,val){$(id).textContent=val}
function row(parent,value){var e=document.createElement('li');e.textContent=String(value);parent.append(e)}
function digest(d){var copy=Object.assign({},d);delete copy.receiptSha256;return crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(copy))).then(function(buf){return Array.from(new Uint8Array(buf)).map(function(x){return x.toString(16).padStart(2,'0')}).join('')})}
function valid(d){return d&&typeof d==='object'&&!Array.isArray(d)&&d.schemaVersion===2&&sha.test(d.baseSha||'')&&sha.test(d.targetSha||'')&&sha.test(d.candidateSha||'')&&Array.isArray(d.checks)&&Array.isArray(d.reasons)&&Array.isArray(d.requiredChecks)&&['READY_FOR_HUMAN_REVIEW','BLOCKED'].includes(d.verdict)&&hash.test(d.receiptSha256||'')}
function draw(d,invalid){
 var svg=$('graph');svg.replaceChildren();
 var blocked=invalid||d.verdict==='BLOCKED';
 var paths=[['M64 113 L202 56','#54d9e6'],['M64 113 L202 174','#54d9e6'],['M220 56 Q300 56 345 113',blocked?'#ff8383':'#7ceb9d'],['M220 174 Q300 174 345 113',blocked?'#ff8383':'#7ceb9d']];
 paths.forEach(function(p){svg.append(node('path',{d:p[0],fill:'none',stroke:p[1],'stroke-width':'2'}))});
 [[64,113,'BASE',d.baseSha,'#54d9e6'],[202,56,'TARGET',d.targetSha,'#54d9e6'],[202,174,'AGENT',d.candidateSha,'#54d9e6'],[355,113,blocked?'BLOCKED':'REVIEW',null,blocked?'#ff8383':'#7ceb9d']].forEach(function(item){
 svg.append(node('circle',{cx:item[0],cy:item[1],r:9,fill:'#0b1418',stroke:item[4],'stroke-width':3}));
 svg.append(node('text',{x:item[0]-20,y:item[1]-19},item[2]));
 if(item[3])svg.append(node('text',{x:item[0]-19,y:item[1]+31,fill:'#92aab2'},item[3].slice(0,7)));
 });
}
async function inspect(d,demo){
 if(!valid(d)){txt('notice','Invalid or unsupported Forge receipt');return}
 var actual=await digest(d),same=actual===d.receiptSha256;
 txt('checksum',same?'MATCH':'MISMATCH');
 txt('target',d.targetSha.slice(0,12));txt('candidate',d.candidateSha.slice(0,12));
 txt('checks-count',String(d.checks.filter(function(c){return c.status==='PASS'}).length)+' / '+d.checks.length+' PASS');
 var state=$('state');state.replaceChildren();var badge=document.createElement('span');badge.className='badge'+(demo?' demo':(!same||d.verdict==='BLOCKED')?' blocked':'');
 badge.textContent=demo?'DEMO · NOT VERIFIED':same?'RECEIPT CLAIM · '+d.verdict:'INVALID CHECKSUM';state.append(badge);
 var reason=$('reasons');reason.replaceChildren();(d.reasons.length?d.reasons:['No blocking reasons reported']).forEach(function(x){row(reason,x)});
 var checks=$('checks');checks.replaceChildren();d.checks.slice(0,40).forEach(function(c){row(checks,(c.status||'UNKNOWN')+' · '+(c.id||'unnamed')+' · SHA-256 '+(c.evidenceSha256||'unavailable'))});
 var paths=$('paths');paths.replaceChildren();var names=Array.isArray(d.candidatePaths)?d.candidatePaths:[];(names.length?names:['No changed paths reported']).slice(0,40).forEach(function(x){row(paths,x)});
 draw(d,!same);txt('notice',demo?'Sample data only':same?'Receipt checksum matches · signer not verified':'WARNING: receipt checksum mismatch');
}
var live = { repo:'', token:'', cursor:0, timer:null, inFlight:false, epoch:0 };
function stopLive(message) {
  if(live.timer!==null)clearInterval(live.timer);
  live.epoch++;live.timer=null;live.token='';live.repo='';live.cursor=0;live.inFlight=false;
  $('live-token').value='';txt('live-status',message||'Disconnected');
}
async function pollLive() {
  if(!live.token||live.inFlight)return;
  live.inFlight=true;
  var epoch=live.epoch;
  try {
    var endpoint='/forge/events/'+encodeURIComponent(live.repo)+'?after='+live.cursor+'&limit=50';
    var response=await fetch(endpoint,{method:'GET',cache:'no-store',credentials:'omit',headers:{authorization:'Bearer '+live.token}});
    if(epoch!==live.epoch)return;
    if(!response.ok) {
      if(response.status===401){stopLive('Capability expired or rejected. Request a new read token.');return}
      throw Error('HTTP '+response.status);
    }
    var data=await response.json();
    if(epoch!==live.epoch)return;
    if(!data||!Array.isArray(data.events)||!Number.isSafeInteger(data.nextCursor))throw Error('Invalid event page');
    if(data.events.length&&live.cursor===0)$('live-events').replaceChildren();
    data.events.forEach(function(item) {
      if(!Number.isSafeInteger(item.sequence)||item.sequence<=live.cursor||!item.event)return;
      var details=item.event;
      row($('live-events'),'#'+item.sequence+' '+(details.type||'?')+' · '+(details.actor||'?')+' · '+(details.commitSha||'').slice(0,9)+' '+(details.detail||''));
    });
    live.cursor=Math.max(live.cursor,data.nextCursor);
    while($('live-events').children.length>60)$('live-events').firstElementChild.remove();
    txt('live-status','Connected to '+live.repo+' · cursor '+live.cursor+' · polling every 4 seconds');
  } catch(error) { if(live.token)txt('live-status','Read failed; will retry. No mutation attempted.'); }
  finally{if(epoch===live.epoch)live.inFlight=false}
}
$('live-connect').addEventListener('click',function(){
  var repo=$('live-repo').value.trim(),token=$('live-token').value.trim();
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(repo)||!token){txt('live-status','Valid repository and read capability required');return}
  stopLive('Connecting');
  live.repo=repo;live.token=token;live.cursor=0;
  $('live-events').replaceChildren();$('live-token').value='';
  pollLive();live.timer=setInterval(pollLive,4000);
});
$('live-disconnect').addEventListener('click',function(){stopLive('Disconnected. No credential retained.');});
window.addEventListener('pagehide',function(){stopLive('Disconnected');});
$('inspect').addEventListener('click',function(){try{if($('json').value.length>1024*1024)throw Error('too large');inspect(JSON.parse($('json').value),false)}catch(e){txt('notice','Invalid or oversized JSON: cannot inspect')}});
$('file').addEventListener('change',async function(event){var f=event.target.files&&event.target.files[0];if(!f)return;if(f.size>1024*1024){txt('notice','File exceeds 1 MB limit');return}try{var raw=await f.text();$('json').value=raw;await inspect(JSON.parse(raw),false)}catch(e){txt('notice','Could not read receipt')}});
$('sample').addEventListener('click',async function(){var d={schemaVersion:2,authority:'gitflare-forge-gate',baseSha:'a'.repeat(40),targetSha:'b'.repeat(40),candidateSha:'c'.repeat(40),targetRef:'main',observedTargetSha:'b'.repeat(40),requiredChecks:['diff-check','git-fsck'],checks:[{id:'diff-check',status:'PASS',evidenceSha256:'d'.repeat(64)},{id:'git-fsck',status:'PASS',evidenceSha256:'e'.repeat(64)}],attestation:{issuer:'example-only',verified:false,signatureAlgorithm:'ed25519'},candidatePaths:['src/parser.ts'],targetPaths:['docs/README.md'],overlapPaths:[],mergeSimulation:{state:'CLEAN',treeSha:'f'.repeat(40)},verdict:'READY_FOR_HUMAN_REVIEW',reasons:[],note:'Illustrative, not a real review'};d.receiptSha256=await digest(d);$('json').value=JSON.stringify(d,null,2);inspect(d,true)});
}());
</script>
</body>
</html>`;
}
