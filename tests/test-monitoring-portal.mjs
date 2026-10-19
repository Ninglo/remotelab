import './isolate-test-environment.mjs';
import assert from 'node:assert/strict';
import {normalizeMonitoringPortal} from '../chat/monitoring-portal.mjs';
assert.equal(normalizeMonitoringPortal({}),null);
for(const url of ['javascript:alert(1)','http://example.com','https://name:secret@example.com','https://example.com/?token=secret','https://example.com/#secret'])assert.equal(normalizeMonitoringPortal({enabled:true,url}),null);
assert.deepEqual(normalizeMonitoringPortal({enabled:true,url:'https://observe.example/'}),{url:'https://observe.example/'});
console.log('monitoring portal configuration passed');
const {readFile}=await import('node:fs/promises');const {runInNewContext}=await import('node:vm');
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
