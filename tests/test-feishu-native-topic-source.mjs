import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {createTopicSource}=createRequire(import.meta.url)('../scripts/feishu-native/topic-source.cjs');
const account='1000000000000000001',origin='http://127.0.0.1:19342';
const grant={token:'fwtops_'+'a'.repeat(43),nativeAccount:account,origin,expiresAt:Date.now()+60000};
let streams=[],requests=[],notify=()=>{};
const source=createTopicSource({origin,remote:'https://fixture.test',heartbeatMs:1000,retryMs:5,onChange:()=>notify(),fetchImpl:async(url,options)=>{
 requests.push({url,options});let controller;
 const body=new ReadableStream({start(c){controller=c;options.signal.addEventListener('abort',()=>{try{c.error(new DOMException('aborted','AbortError'));}catch{}});}});
 streams.push(controller);return new Response(body);
}});
const change=action=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('projection deadline')),2000);notify=()=>{clearTimeout(timer);resolve();};action();});
const send=(i,data)=>streams[i].enqueue(new TextEncoder().encode('data: '+JSON.stringify(data)+'\n\n'));
try{
 source.update(account,null,['11'],['22']);assert.equal(requests.length,0);
 source.update(account,{...grant,nativeAccount:'1000000000000000002'},['11'],['22']);assert.equal(requests.length,0);
 source.update(account,grant,['11'],['22']);
 assert.equal(new URL(requests[0].url).searchParams.get('groups'),'22');
 assert.equal(requests[0].options.headers['X-Feishu-Account'],account);
 await change(()=>send(0,{sourceConnected:true,entries:[{webThreadId:'11',name:'中文标题',status:'running'}],boards:[{id:'board'}]}));
 assert.equal(source.projection(account).entries[0].name,'中文标题');
 assert.equal(source.projection('other').sourceConnected,false);
 source.update(account,grant,['11','11'],['22']);assert.equal(requests.length,1);
 await change(()=>streams[0].close());
 assert.equal(source.projection(account).sourceConnected,false);
 // Changing visible context cancels old retries and opens one scoped stream.
 source.update(account,grant,['12'],['23']);assert.equal(requests.length,2);
 assert.deepEqual(source.projection(account).entries,[]);
 await change(()=>send(1,{sourceConnected:true,entries:[{webThreadId:'12',status:'waiting'}],boards:[]}));
 assert.equal(source.projection(account).entries[0].status,'waiting');
 source.remove(account);assert.equal(requests[1].options.signal.aborted,true);
 assert.equal(source.projection(account).sourceConnected,false);
 console.log('Standalone topic source: explicit grant, account isolation, groups, stale state and context replacement passed');
}finally{source.close();}
