import './isolate-test-environment.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { aggregateGroupMonitoring, projectGroupRequest, collectGroupMonitoring } from '../chat/monitoring-groups.mjs';
import { projectInbox, recordKey, sourceKey, classifyMessageOrigin, createMessageOriginLookup, monitoringConnectorSources } from '../chat/monitoring-message-origin.mjs';
import { buildAgentDashboard } from '../chat/monitoring-dashboard.mjs';
import { projectRequest, runMeasurement } from '../chat/monitoring-sessions.mjs';
const start=Date.parse('2026-10-22T21:00:00Z'), now=start+60000, route='bot';
const src=(id, extra={})=>({connector:'feishu',sourceRouteId:route,chatType:'group',chatMode:'group',conversationKind:'group',chatId:'chat',messageId:id,createTime:String(start),...extra});
assert.equal(classifyMessageOrigin(src('a'),true).kind,'group-mainline');
for(const extra of [{chatMode:'topic'},{threadId:'thread'},{chatType:'p2p'}])assert.equal(classifyMessageOrigin(src('a',extra),true).kind,'ordinary');
assert.equal(classifyMessageOrigin(src('a',{rootId:'quoted-mainline-message'}),true).kind,'group-mainline');
assert.equal(classifyMessageOrigin(src('a',{startThread:true,conversationKind:'thread'})).kind,'unknown');
assert.equal(classifyMessageOrigin({chatType:'group',conversationKind:'thread'}).kind,'unknown');
const msg=(id,extra={})=>({id:sourceKey(route,id),route,groupId:sourceKey(route,'chat'),source:src(id),at:start,complete:true,intake:'accepted',sessionId:'main',originSessionId:'main',requestId:id,runId:'r',...extra});
const part=(id,extra={})=>({id,kind:'content',state:'delivered',surfaceKind:'final',externalId:id,createdAt:start+1000,deliveredAt:start+2000,
 target:{chatId:'chat',messageId:'a',conversationKind:'main'},...extra});
const req=(id,extra={})=>({sessionId:'main',requestId:id,runId:'r',source:src(id),state:'completed',deliveries:[],...extra});
const requests=[req('a',{ownerRequestId:'a',replyRequestIds:['a','b'],deliveries:[part('text'),part('text',{deliveredAt:start+3000}),
  part('social',{kind:'reaction',emojiType:'THANKS',deliveredAt:start+1000}),part('remove',{kind:'reaction',processingState:'finished'}),
  part('processing',{kind:'reaction',processingState:'active'}),
  part('foreign',{publicationRequestId:'not-this-input',deliveredAt:start+1}),
]}), req('b',{ownerRequestId:'a',replyRequestIds:['a','b'],nativeDispatchRunId:'r'}),req('silent',{noText:true}),req('missing'),
 req('failed',{state:'failed'}),req('running',{state:'pending'}),req('thread',{deliveries:[part('new-1',{deliveredThreadId:'new',target:{chatId:'chat',messageId:'thread',sourceKind:'ambient_thread_open',replyInThread:true}}),
 part('new-2',{deliveredThreadId:'new',target:{chatId:'chat',messageId:'thread',startThread:true}}),
 part('existing',{target:{chatId:'chat',threadId:'existing',conversationKind:'thread'}}),
 part('no-thread-receipt',{target:{chatId:'chat',startThread:true}})]})];
const inputs=['a','b','silent','missing','failed','running','thread'].map(id=>msg(id));
inputs.push(msg('observed',{intake:'observed'}),msg('skipped',{intake:'skipped'}),msg('child',{sessionId:'child',workSessionId:'child',runId:'child-run'}));
const ledger=[{runId:'r',sessionId:'main',ts:new Date(start).toISOString(),totalTokens:100,cachedInputTokens:80},
 {runId:'r',sessionId:'main',ts:new Date(start).toISOString(),totalTokens:100,cachedInputTokens:80},
 {runId:'child-run',sessionId:'child',ts:new Date(start).toISOString(),totalTokens:900},
 {runId:'unmatched',sessionId:'main',ts:new Date(start-1).toISOString(),totalTokens:30}];
const result=aggregateGroupMonitoring({inputs:[...inputs,inputs[0]],requests,ledger,now,
 sessions:[{id:'main',groupFeed:true},{id:'child'}],groups:[{id:'chat',enabled:true,mode:'listening'}],
 reactions:[{sourceId:msg('a').id,id:sourceKey(route,'social'),at:start+500,kind:'social'},
 {sourceId:msg('silent').id,id:'retained-replaced',at:null,kind:'social'}]});
const d=result.today;
assert.equal(d.received,10);assert.equal(d.textReceipts,5);assert.equal(d.inlineReplies,1);
assert.equal(d.newThreads,1);assert.equal(d.newThreadReplies,2);assert.equal(d.existingThreadReplies,1);assert.equal(d.unknownPlacementReplies,1);
assert.equal(d.withTextReceipt,3);assert.equal(d.mergedInputs,1);assert.equal(d.textLatency.count,2);assert.equal(d.textLatency.mean,2000);
assert.equal(d.reactionReceipts,2);assert.equal(d.reactionTimeUnknown,1);assert.equal(d.reactionLatency.mean,1000);
assert.equal(d.processingReceipts,1);assert.equal(d.noReply,3);assert.equal(d.unconfirmed,2);assert.equal(d.failed,1);assert.equal(d.processing,1);
assert.equal(['processed','noReply','failed','processing','unconfirmed'].reduce((n,k)=>n+d[k],0),10);
assert.equal(d.usage.runs,1);assert.equal(d.usage.totalTokens,100);assert.equal(result.days.at(-2).usage.totalTokens,30);
assert.equal(result.coverage.excludedRelatedRuns,1);assert.equal(result.current.listening,1);
assert.equal(result.coverage.unattributedTextReceipts,1);
const failedSend=aggregateGroupMonitoring({inputs:[msg('a')],requests:[req('a',{deliveries:[part('failed-send',{state:'failed'})]})],now});
assert.equal(failedSend.today.failed,1);assert.equal(failedSend.coverage.failedDeliveryInputs,1);
assert(!JSON.stringify(result).includes('child-run'));assert(!JSON.stringify(result).includes('not-this-input'));
// Input attribution remains strict even if another input produced visible text sooner.
const raw={requestId:'a',sessionId:'s',runId:'r',acceptedAt:start,settledAt:start+10000,options:{sourceContext:src('a',{chatType:'p2p'})},deliveries:[
 {...part('other',{publicationRequestId:'supplement',deliveredAt:start+100}),connector:'feishu'},
 {...part('own',{publicationRequestId:'a',deliveredAt:start+20000}),connector:'feishu'}]};
const sample=runMeasurement({sessionId:'s',runId:'r',ts:new Date(start).toISOString()},{id:'r',sessionId:'s',state:'completed'},projectRequest(raw));
assert.equal(sample.metrics.firstResponseMs,20000);
const dashboard=buildAgentDashboard({},[sample,{...sample,origin:{kind:'group-mainline',basis:'inbox'}},{...sample,origin:{kind:'unknown',basis:'request'}}],now,{});
assert.equal(dashboard.today.firstResponse.count,1);assert.equal(dashboard.today.firstResponse.mean,20000);
assert.deepEqual(dashboard.today.originCoverage,{ordinary:1,groupMainline:1,unknown:1,requestFallback:2});
assert(!JSON.stringify(projectGroupRequest({...raw,text:'PRIVATE',mainlineReply:{contract:{payload:{text:'PRIVATE'},noTextReason:'PRIVATE'}}})).includes('PRIVATE'));
const dir=await mkdtemp(join(tmpdir(),'monitor-groups-'));
try {
 const fsRead=async(p,project)=>{try{return project(JSON.parse(await (await import('node:fs/promises')).readFile(p,'utf8')))}catch(e){if(e.code==='ENOENT')return null;throw e}};
 const write=async(p,data)=>{await mkdir(join(p,'..'),{recursive:true});await writeFile(p,JSON.stringify(data))};
 await write(join(dir,'feishu-connectors','bot','config.json'),{botId:'bot',storageDir:'/compat/state',appSecret:'PRIVATE',defaultGroupParticipation:'active',groups:{chat:{participationMode:'ambient',participationControls:true,systemPrompt:'PRIVATE'}}});
 const connectors=await monitoringConnectorSources(dir,fsRead,{'/compat/state':join(dir,'state')});
 assert(!JSON.stringify(connectors).includes('PRIVATE'));
 const inbox={id:'a',summary:src('a'),complete:true,participationSnapshot:{mode:'listening'},receipt:{observedOnly:true}};
 await write(join(dir,'state','inbox','archive',recordKey('a')+'.json'),inbox);
 const lookup=createMessageOriginLookup(connectors,fsRead);
 assert.equal((await lookup(src('a',{conversationKind:'thread',chatMode:'topic',threadId:'rewritten-target'}))).kind,'group-mainline','original inbox wins over rewritten reply destination');
 await write(join(dir,'state','participation-state','active','abcd.json'),{source:{chatId:'chat',topicId:''},mode:'listening',modeOverride:true});
 await write(join(dir,'state','outcome-reactions','active','abce.json'),{messageId:'a',reactionId:'reaction',sequence:start+250,revision:2});
 const r=await collectGroupMonitoring({connectors,read:fsRead,requestFor:async()=>null,sessions:[],ledger:[],now,coverage:{limitedFiles:0,readErrors:0}});
 assert.equal(r.current.listening,1);assert.equal(r.today.received,1);assert.equal(r.today.noReply,1);assert.equal(r.today.reactionTimeUnknown,1);assert.equal(r.today.reactionLatency.count,0);
 assert.equal(projectInbox({summary:src('a'),submission:{sessionId:'main'},receipt:{sessionId:'main',workSessionId:'child'}}).sessionId,'child');
 // A routed work topic requires a source anchor and a real external thread receipt.
 await write(join(dir,'state','inbox','archive',recordKey('a')+'.json'),{...inbox,submission:{sessionId:'main',payload:{requestId:'a'}},receipt:{requestId:'a',runId:'r'}});
 const childRequest={...raw,sessionId:'child',requestId:'routed:a',deliveries:[{...part('topic',{deliveredThreadId:'actual-topic'}),connector:'feishu'}]};
 const collect=()=>collectGroupMonitoring({connectors,read:fsRead,requestFor:async(s,id)=>projectRequest(s==='child'&&id==='routed:a'?childRequest:raw),
   sessions:[{id:'main',groupRouting:{routes:[{state:'submitted',targetSessionId:'child',requestIds:['a']}]}},
     {id:'child',externalTriggerId:'routing-pilot:test',conversation:{target:{messageId:'a'}}}],ledger:[],now,coverage:{limitedFiles:0,readErrors:0}});
 const routed=await collect();assert.equal(routed.today.newThreads,1);assert.equal(routed.today.newWorkSessions,1);assert.equal(routed.today.topicLatency.mean,2000);
 childRequest.deliveries[0].deliveredThreadId=undefined;
 const missingTopic=await collect();assert.equal(missingTopic.today.newThreads,0);assert.equal(missingTopic.coverage.topicReceiptMissing,1);
} finally { await rm(dir,{recursive:true,force:true}) }
console.log('monitoring groups: original source, exclusive outcomes, combined coverage, strict input ownership, receipt/Run dedupe, child cost exclusion, states, gaps and day boundary passed');
