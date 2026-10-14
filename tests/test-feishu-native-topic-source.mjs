import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {createTopicSource}=createRequire(import.meta.url)('../scripts/feishu-native/topic-source.cjs');
const account='1000000000000000001',origin='http://127.0.0.1:19342';
const grant={token:'fwtops_'+'a'.repeat(43),nativeAccount:account,origin,expiresAt:Date.now()+60000};
let streams=[],requests=[],notify=()=>{},denied=false;
const source=createTopicSource({origin,remote:'https://fixture.test',heartbeatMs:1000,retryMs:5,onChange:()=>notify(),fetchImpl:async(url,options)=>{
 requests.push({url,options});let controller;
 if(denied)return new Response(JSON.stringify({error:'revoked'}),{status:403});
 const body=new ReadableStream({start(c){controller=c;options.signal.addEventListener('abort',()=>{try{c.error(new DOMException('aborted','AbortError'));}catch{}});}});
 streams.push(controller);return new Response(body);
}});
const change=action=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('projection deadline')),2000);notify=()=>{clearTimeout(timer);resolve();};action();});
const data=status=>({sourceConnected:true,entries:[{webThreadId:'11',name:'中文标题',status}],boards:[{id:'board'}]});
const send=(i,data)=>streams[i].enqueue(new TextEncoder().encode('data: '+JSON.stringify(data)+'\n\n'));
try{
 source.update(account,null,['11'],['22']);assert.equal(requests.length,0);
 source.update(account,{...grant,nativeAccount:'1000000000000000002'},['11'],['22']);assert.equal(requests.length,0);
 source.update(account,grant,['11'],['22']);
 assert.equal(new URL(requests[0].url).searchParams.get('groups'),'22');
 assert.equal(requests[0].options.headers['X-Feishu-Account'],account);
 await change(()=>send(0,data('running')));
 assert.equal(source.projection(account).entries[0].name,'中文标题');
 assert.equal(source.projection('other').sourceConnected,false);
 for(let i=0;i<20;i++){source.update(account,grant,[],[]);source.update(account,grant,['11','11'],['22']);}
 assert.equal(requests.length,1,'virtual-list empty commits must not restart the stream');
 source.update(account,grant,['12'],['23']);assert.equal(requests.length,2);
 assert.equal(requests[0].options.signal.aborted,false);
 assert.equal(source.projection(account).entries[0].status,'running');
 assert.equal(source.projection(account).sourceConnected,true);
 await change(()=>send(0,data('review')));
 assert.equal(source.projection(account).entries[0].status,'review','old subscription still receives live changes');
 source.update(account,grant,['13'],[]);assert.equal(requests.length,3);
 assert.equal(requests[1].options.signal.aborted,true,'cancel only superseded pending query');
 assert.equal(requests[0].options.signal.aborted,false);
 assert.equal(new URL(requests[2].url).searchParams.get('ids'),'11,12,13');
 await change(()=>send(2,{...data('waiting'),entries:[...data('waiting').entries,{webThreadId:'13',status:'running'}]}));
 assert.equal(requests[0].options.signal.aborted,true,'handoff happens after replacement snapshot');
 assert.equal(source.projection(account).entries[0].status,'waiting');
 await change(()=>streams[2].close());
 assert.equal(source.projection(account).sourceConnected,false);
 assert.equal(source.projection(account).entries.length,2,'real disconnect keeps labels with explicit stale status');
 const renewed={...grant,token:'fwtops_'+'b'.repeat(43)};
 source.update(account,renewed,['14'],[]);
 assert.deepEqual(source.projection(account).entries,[],'no retained data across grant changes');
 await change(()=>send(3,data('running')));
 denied=true;
 await change(()=>source.update(account,renewed,['15'],[]));
 assert.equal(requests[3].options.signal.aborted,true,'revocation stops the fallback too');
 assert.deepEqual(source.projection(account).entries,[]);
 assert.equal(source.projection(account).sourceConnected,false);
 source.remove(account);
 console.log('Standalone topic source: viewport churn, continuous live handoff, pending cancellation, disconnect, revocation and account isolation passed');
}finally{source.close();}

// A connection sending only keepalives must not strand a new subscription.
// Its old, still-live scope stays visible while the replacement retries.
{
 let requests=0, oldStream, replacementAborted=false, resolveRetry;
 const retried=new Promise(resolve=>resolveRetry=resolve);
 const timer=setTimeout(()=>resolveRetry(false),2000);
 const snapshotSource=createTopicSource({origin,remote:'https://fixture.test',heartbeatMs:1000,snapshotMs:30,retryMs:5,onChange:()=>{},fetchImpl:async(url,{signal})=>{
  requests++;
  if(requests===3)resolveRetry(true);
  let c;
  const body=new ReadableStream({start(controller){c=controller;signal.addEventListener('abort',()=>{if(requests===2)replacementAborted=true;try{controller.error(new DOMException('aborted','AbortError'));}catch{}});}});
  if(requests===1){oldStream=c;c.enqueue(new TextEncoder().encode('data: '+JSON.stringify(data('running'))+'\n\n'));}
  else c.enqueue(new TextEncoder().encode(': heartbeat\n\n'));
  return new Response(body);
 }});
 try {
  snapshotSource.update(account,grant,['11'],[]);
  await new Promise(resolve=>setImmediate(resolve));
  snapshotSource.update(account,grant,['12'],[]);
  assert.equal(await retried,true,'initial snapshot timeout must retry despite heartbeat');
  assert.equal(replacementAborted,true);
  assert.equal(snapshotSource.projection(account).entries[0].status,'running');
  oldStream.enqueue(new TextEncoder().encode('data: '+JSON.stringify(data('review'))+'\n\n'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(snapshotSource.projection(account).entries[0].status,'review','fallback remains live during retry');
  console.log('Initial snapshot timeout and continuous fallback passed');
 } finally {clearTimeout(timer);snapshotSource.close();}
}
