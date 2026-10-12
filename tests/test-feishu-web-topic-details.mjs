import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setIsolatedTestHome} from './isolate-test-environment.mjs';
const scratch=await mkdtemp(join(tmpdir(),'topic-details-'));setIsolatedTestHome(scratch);
const {createTopicDetails}=await import('../chat/feishu-web-topic-details.mjs');
const html='<!doctype html><html>fixture</html>',sha=createHash('sha256').update(html).digest('hex');
let seq=3,reads=[];
const now=new Date().toISOString();
const details=createTopicDetails({head:async()=>seq,history:async(id,options)=>{reads.push({id,options});return [{type:'usage',seq,contextTokens:seq*100,contextWindowTokens:10000,timestamp:now}];},
 totals:async()=>({generatedAt:now,bySession:[{sessionId:'one',totalTokens:9999,runCount:2},{sessionId:'private',totalTokens:1,runCount:1}]}),
 auth:{getStatus:async()=>({loggedIn:true,accountRevision:'same',account:{email:'never return'}}),getRateLimits:async()=>({accountRevision:'same',status:'ready',checkedAt:now,buckets:[{id:'codex',primary:{remainingPercent:0,windowDurationMins:300}}]})},
 fileStat:async()=>({size:1000}),read:async()=>JSON.stringify({schema:1,artifacts:[
  {id:'ok',sessionId:'one',chatId:'group',rootId:'root',versions:[{number:1,source:html,sha256:sha,delivery:{webThreadId:'11',nativeMessageId:'123456789012345'}}]},
  {id:'wrong-root',sessionId:'one',chatId:'group',rootId:'other',versions:[]},
  {id:'private',sessionId:'private',chatId:'private',rootId:'root',versions:[]},
  {id:'corrupt',sessionId:'one',chatId:'group',rootId:'root',versions:[{number:1,source:html,sha256:'wrong'}]}
 ]})});
try{
 const entries=[{sessionId:'one',webThreadId:'11',chatId:'group',rootId:'root'}],config={artifactsFile:'/trusted/registry.json'};
 const data=await details(entries,config);
 assert.equal(data.entries[0].usage.cumulative.totalTokens,9999);
 assert.equal(data.entries[0].usage.context.tokens,300);
 assert.equal(data.quota.windows[0].remainingPercent,0);
 assert(!JSON.stringify(data).includes('never return'));
 assert.deepEqual(data.webArtifacts.map(a=>a.id),['ok','corrupt']);
 assert.equal(data.webArtifacts[0].versions[0].nativeMessageId,'123456789012345');
 assert.deepEqual(data.webArtifacts[1].versions,[]);
 await details(entries,config);assert.equal(reads.length,1);
 seq=4;await details(entries,config);assert.equal(reads[1].options.fromSeq,4);
 assert(reads.every(r=>r.id==='one'&&r.options.includeBodies===false));
 const missing=await createTopicDetails({head:async()=>0,totals:async()=>{throw Error('offline');},auth:{getStatus:async()=>null,getRateLimits:async()=>null}})(entries,{});
 assert.equal(missing.entries[0].usage.cumulative,null);assert.equal(missing.quota.status,'unavailable');
 console.log('Topic details: scoped usage, incremental context, zero quota, artifact identity/hash and unavailable data passed');
}finally{await rm(scratch,{recursive:true,force:true});}
