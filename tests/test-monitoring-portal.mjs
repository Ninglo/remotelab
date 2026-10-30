import './isolate-test-environment.mjs';
import assert from 'node:assert/strict';
import {normalizeMonitoringPortal} from '../chat/monitoring-portal.mjs';
import {rewriteMonitoringPresentation,handleMonitoringPreview} from '../chat/router-monitoring-preview.mjs';
import http from 'node:http';
import {once} from 'node:events';
const scoped=rewriteMonitoringPresentation('<a href="/">Home</a><a href="/case-review/">Cases</a>fetch(\'/api/monitoring-resolution\');fetch(\'/api/snapshot\')',{publicOrigin:'https://observe.example'});
assert(scoped.includes('href="/monitoring-preview/"'));
assert(scoped.includes('href="/monitoring-preview/case-review/"'));
assert.equal(rewriteMonitoringPresentation("fetch('/api/auth/me');fetch('/api/project-feedback?caseProject=x');"),"fetch('/api/auth/me');fetch('/api/project-feedback?caseProject=x');");
assert(scoped.includes("fetch('/api/monitoring-resolution')"));
assert(scoped.includes("fetch('/monitoring-preview/api/snapshot')"));
// Proxying the dashboard must preserve date labels and other plain separators.
const dateFormatter="new Date('2026-10-19T00:00:00Z').toISOString().slice(5,10).replace('-','/')";
assert.equal(rewriteMonitoringPresentation(dateFormatter),dateFormatter);
assert.equal(rewriteMonitoringPresentation("parts.join('/'); text.split(\"/\");"),"parts.join('/'); text.split(\"/\");");
assert.equal(rewriteMonitoringPresentation("<a href = '/'>Home</a>"),"<a href = '/monitoring-preview/'>Home</a>");
assert.equal(rewriteMonitoringPresentation("import '/feature-trials.js'"),"import '/monitoring-preview/feature-trials.js'");
// A missing imported module prevents every interactive dashboard control from loading.
const upstream=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/javascript'});res.end('export const trials = [];')});
upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
const proxy=http.createServer((req,res)=>{void handleMonitoringPreview({req,res,pathname:new URL(req.url,'http://local').pathname,configOverride:{previewPort:upstream.address().port}})});
proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
try{
 const base='http://127.0.0.1:'+proxy.address().port;
 const response=await fetch(base+'/monitoring-preview/feature-trials.js');assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/javascript/);assert.match(await response.text(),/export const trials/);
 assert.equal((await fetch(base+'/monitoring-preview/group-participation.js')).status,200);
 for(const asset of ['gpu-pool.js','account-view.js','usage-governance.js','employee-view.js','case-review/case-metadata.js'])assert.equal((await fetch(base+'/monitoring-preview/'+asset)).status,200,asset);
 assert.equal((await fetch(base+'/monitoring-preview/private.json')).status,405);
}finally{await Promise.all([new Promise(r=>proxy.close(r)),new Promise(r=>upstream.close(r))])}
assert.equal(normalizeMonitoringPortal({}),null);
for(const url of ['javascript:alert(1)','http://example.com','https://name:secret@example.com','https://example.com/?token=secret','https://example.com/#secret'])assert.equal(normalizeMonitoringPortal({enabled:true,url}),null);
assert.deepEqual(normalizeMonitoringPortal({enabled:true,url:'https://observe.example/'}),{url:'https://observe.example/'});
console.log('monitoring portal configuration passed');
const {readFile}=await import('node:fs/promises');const {runInNewContext}=await import('node:vm');
assert.equal(runInNewContext(rewriteMonitoringPresentation(dateFormatter)),'10/19');
const source=await readFile(new URL('../static/chat/monitoring.js',import.meta.url),'utf8');
for(const [view,tab] of [['overview','overview'],['security','safety'],['usage','usage'],['feedback','labor'],['test','overview']]){
 const assigned=[],panel={replaceChildren(...nodes){this.nodes=nodes}};
 const window={__REMOTELAB_BOOTSTRAP__:{monitoringPortal:{url:'https://observe.example/'}},location:{href:'https://app.example/?tab=tasks&monitor='+view,assign:url=>assigned.push(url)}};
 const document={getElementById:id=>id==='taskCenterPanel'?panel:null,createElement:()=>({})};
 runInNewContext(source,{window,document,URL});assert.equal(new URL(assigned[0]).searchParams.get('tab'),tab);assert(panel.nodes[1].href.startsWith('https://observe.example/'));
 assert.equal(window.RemoteLabMonitoring.isOverview(),true);
}
for(const query of ['monitor=automations','monitor=security&manage=1','monitor=usage&manage=1','monitor=feedback&manage=1','monitor=overview&manage=1']){
 let redirected=false,back;
 const window={__REMOTELAB_BOOTSTRAP__:{monitoringPortal:{url:'https://observe.example/'}},location:{href:'https://app.example/?tab=tasks&'+query,assign:()=>{redirected=true}}};
 const document={getElementById:id=>id==='taskCenterPanel'?{prepend:x=>back=x,querySelector:()=>({style:{}})}:null,createElement:()=>({})};
 runInNewContext(source,{window,document,URL});assert.equal(redirected,false);assert.equal(back.href,'https://observe.example/');
}
console.log('passed: mapped dashboard links, explicit authenticated management retained');

assert.deepEqual(normalizeMonitoringPortal({enabled:false,preview:true,url:'https://observe.example/'}),{url:'https://observe.example/',preview:true});
for(const view of ['overview','usage','feedback','security','automations']) {
 let redirected=false,changed=false;
 const window={__REMOTELAB_BOOTSTRAP__:{monitoringPortal:{url:'https://observe.example/',preview:true}},location:{href:'https://app.example/?tab=tasks&monitor='+view,assign:()=>{redirected=true}}};
 const document={getElementById:id=>id==='taskCenterPanel'?{replaceChildren:()=>{changed=true},prepend:()=>{changed=true}}:null};
 runInNewContext(source,{window,document,URL});assert.equal(redirected,false);assert.equal(changed,false);
}
console.log('passed: preview leaves all original monitoring views unchanged');
