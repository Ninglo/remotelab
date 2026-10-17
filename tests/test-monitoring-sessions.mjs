import './test-monitoring-dashboard.mjs';
import './test-response-timing.mjs';
import './isolate-test-environment.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { projectInjection, summarizeSessionOverview, compactSessionMonitoring, sessionOwnership, projectRequest, runMeasurement, summarizeMeasurements, measurementSignals, createSessionMonitoringReader } from '../chat/monitoring-sessions.mjs';
const people=[{id:'p1',name:'A',identities:[{id:'i1'},{id:'i2'}]}];
const source={connector:'feishu',chatId:'c1',chatType:'group',chatName:'Team',tenantKey:'t1'};
const own=sessionOwnership({initiatedByIdentityId:'i2',sourceContext:source},people);
assert.equal(own.personId,'p1');assert.equal(own.groupName,'Team');
assert.equal(own.groupId,sessionOwnership({sourceContext:{...source,sourceRouteId:'another-bot'}},[]).groupId);
assert.notEqual(own.groupId,sessionOwnership({sourceContext:{...source,tenantKey:'t2'}},[]).groupId);
assert.notEqual(sessionOwnership({sourceContext:source,conversation:{connector:'feishu',target:{chatId:'c2',chatType:'group',tenantKey:'t1'}}},[]).groupName,'Team');
assert.equal(sessionOwnership({personViews:{p1:{group:'sidebar'}}},[]).personId,'unknown');
const ledger={runId:'r1',sessionId:'s1',ts:'2026-01-01T00:05:00Z',inputTokens:100,contextTokens:0,model:'m',tool:'t'};
const run={id:'r1',sessionId:'s1',startedAt:'2026-01-01T00:00:05Z',completedAt:'2026-01-01T00:05:00Z'};
const request={sessionId:'s1',runId:'r1',acceptedAt:'2026-01-01T00:00:00Z',preparedAt:'2026-01-01T00:00:03Z',settledAt:'2026-01-01T00:05:01Z',deliveries:[{state:'delivered',deliveredAt:'2026-01-01T00:05:04Z'}]};
const injection=projectInjection({id:'r1',sessionId:'s1',modelContext:'中文ABC',prompt:'private user content'});
assert.equal(injection.injectionBytes,9);assert(!JSON.stringify(injection).includes('private'));
assert.equal(runMeasurement(ledger,run,request,injection).metrics.injectionBytes,9);
assert.equal(runMeasurement(ledger,run,request,{...injection,sessionId:'other'}).metrics.injectionBytes,null);
const means=summarizeSessionOverview([{totalTokens:100,metrics:{injectionBytes:{mean:10,count:1}}},{totalTokens:300,archived:true,metrics:{injectionBytes:{mean:30,count:3}}},{totalTokens:null,metrics:{}}]);
assert.equal(means.meanUsageTokens,200);assert.equal(means.meanInjectionBytes,25);assert.equal(means.currentSessions,2);assert.equal(means.injectionCount,4);
assert.equal(summarizeSessionOverview([{totalTokens:null,metrics:{}}]).meanUsageTokens,null);
assert.equal(summarizeSessionOverview([]).meanInjectionBytes,null);
const sample=runMeasurement(ledger,run,request);assert.equal(sample.metrics.prepareMs,3000);assert.equal(sample.metrics.launchMs,2000);assert.equal(sample.metrics.deliveryMs,3000);assert.equal(sample.metrics.contextTokens,0);
assert.equal(runMeasurement(ledger,run,{...request,nativeDispatchRunId:'r0'}).metrics.prepareMs,null);
assert.equal(runMeasurement(ledger,run,{...request,excluded:true}).background,true);
assert.equal(runMeasurement(ledger,run,{...request,preparedAt:'2025-01-01'}).metrics.prepareMs,null);
assert.equal(runMeasurement(ledger,{...run,sessionId:'wrong'},request).metrics.runMs,null);
assert.equal(runMeasurement(ledger,run,{...request,deliveries:[{state:'pending'}]}).metrics.deliveryMs,null);
assert.equal(projectRequest({options:{},text:'private',deliveries:[]}).text,undefined);
const responseRequest=projectRequest({...request,requestId:'q',options:{sourceContext:{connector:'feishu'}},deliveries:[
 {connector:'feishu',kind:'content',surfaceKind:'opening',state:'delivered',deliveredAt:'2026-01-01T00:00:08Z',text:'private body'},
 {connector:'feishu',kind:'content',surfaceKind:'reply',state:'delivered',deliveredAt:'2026-01-01T00:00:13Z'},
]});
const responseSample=runMeasurement(ledger,run,responseRequest);
assert.equal(responseSample.metrics.firstContentMs,8000);assert.equal(responseSample.metrics.firstReplyMs,13000);
assert.equal(responseSample.responseEligible,true);assert(!JSON.stringify(responseRequest).includes('private'));
assert.equal(runMeasurement(ledger,run,{...responseRequest,nativeDispatchRunId:'old'}).metrics.firstReplyMs,null);

assert.equal(summarizeMeasurements([sample,{metrics:{}}]).prepareMs.count,1);
const samples=Array.from({length:13},(_,i)=>({at:i*1000,model:'m',tool:'t',metrics:{contextTokens:i>=10?50000:10000}}));
assert.equal(measurementSignals(samples)[0].severity,'critical');assert.equal(measurementSignals(samples)[0].baselineCount,10);
assert.equal(measurementSignals(samples.slice(1)).length,0);
assert.equal(measurementSignals(samples.map(s=>({...s,model:s.at>=10000?'new-model':'m'}))).length,0);
assert.equal(measurementSignals(samples.map(s=>({...s,metrics:{contextTokens:s.at>=10000?10:0}}))).length,0);
const root=await mkdtemp(join(tmpdir(),'monitor-session-test-'));
try {
 await mkdir(join(root,'runs','r1'),{recursive:true});await mkdir(join(root,'requests','archive'),{recursive:true});
 await writeFile(join(root,'sessions.json'),JSON.stringify([{id:'s1',initiatedByIdentityId:'i1',sourceContext:source,systemPrompt:'private'}]));
 await writeFile(join(root,'runs','r1','manifest.json'),JSON.stringify({id:'r1',sessionId:'s1',modelContext:'abc',prompt:'private'}));
 await writeFile(join(root,'runs','r1','status.json'),JSON.stringify({...run,requestId:'q1'}));
 const address=createHash('sha256').update(JSON.stringify(['s1','q1'])).digest('hex').slice(0,24);
 await writeFile(join(root,'requests','archive',address+'.json'),JSON.stringify({...request,text:'private',options:{}}));
 let calls=0,clock=0;const reader=createSessionMonitoringReader({configDir:root,runsDir:join(root,'runs'),sessionsFile:join(root,'sessions.json'),now:()=>clock,getPeople:async()=>people,getUsage:async()=>{calls++;return {runCount:1,topRuns:[ledger],bySession:[{sessionId:'s1'}]}}});
 const [a,b]=await Promise.all([reader(),reader()]);assert.equal(calls,1);assert.equal(a,b);assert.equal(a.sessions[0].metrics.prepareMs.mean,3000);assert(!JSON.stringify(a).includes('private'));
 clock=61000;const second=await reader();assert.equal(calls,2);assert.equal(second.coverage.bytesRead,0);assert.equal(second.coverage.cacheHits,3);
 // Current runs store execution/recovery as sparse shards without identity.
 await writeFile(join(root,'runs','r1','execution.json'),JSON.stringify({state:'completed',startedAt:run.startedAt,completedAt:run.completedAt}));
 await writeFile(join(root,'runs','r1','recovery.json'),JSON.stringify({updatedAt:'2026-01-01T00:06:00Z'}));
 clock=122000;const split=await reader();
 assert.equal(split.sessions[0].metrics.prepareMs.mean,3000,'sparse shards preserve request association');
 assert.equal(split.sessions[0].metrics.injectionBytes.mean,3,'sparse shards preserve manifest association');
 assert.equal(split.sessions[0].metrics.runMs.mean,295000,'execution times survive a sparse recovery shard');
 const shardReader=createSessionMonitoringReader({configDir:root,runsDir:join(root,'runs'),sessionsFile:join(root,'sessions.json'),now:()=>Date.parse('2026-01-01T01:00:00Z'),getPeople:async()=>people,getUsage:async()=>({runCount:1,trendRuns:[ledger],bySession:[]})});
 const dashboard=await shardReader({days:7,dashboard:true});
 assert.equal(dashboard.agentDashboard.today.injection.count,1);
 assert.equal(dashboard.agentDashboard.today.injection.mean,3);
 const bounded=createSessionMonitoringReader({configDir:root,runsDir:join(root,'runs'),sessionsFile:join(root,'sessions.json'),maxReadBytes:0,getPeople:async()=>people,getUsage:async()=>({runCount:1,topRuns:[ledger],bySession:[]})});
 const c=await bounded();assert(c.coverage.truncated);assert.equal(c.sessions[0].metrics.prepareMs.count,0);
 const compact=await compactSessionMonitoring({...a,usage:{bySession:[{sessionId:'s1',totalTokens:400}],totals:{totalTokens:400}}},async()=>({run:{state:'running',waiting:true},queue:{count:0}}));
 assert.equal(compact.summary.meanInjectionBytes,3);assert.equal(compact.summary.meanUsageTokens,400);
 assert.equal(compact.sessions[0].totalTokens,400);assert.equal(compact.sessions[0].activity.run.waiting,true);
 assert.equal(compact.groups[compact.sessions[0].groupId],'Team');assert.equal(compact.people.p1,'A');
 assert.equal(compact.sessions[0].metrics.prepareMs.mean,3000);assert(!('basis' in compact.sessions[0]));
 assert(!('groupName' in compact.sessions[0]));assert(!JSON.stringify(compact).includes('private'));
 const unknown=await compactSessionMonitoring(a,async()=>{throw Error('missing')});assert.equal(unknown.sessions[0].activity.run.state,'unknown');
 const noSamples=await compactSessionMonitoring(c,async()=>({run:{state:'idle'}}));assert(!noSamples.sessions[0].metrics.prepareMs);
 // The annotation follows durable switches without exposing experiment evidence or raw prompts.
 assert.equal(a.contextExperiment,null);
 const experimentDir=join(root,'feature-experiments','trial');
 await mkdir(experimentDir,{recursive:true});
 const spec={schema:1,id:'trial',kind:'context-background-v1',mode:'ab',personIds:['p1'],since:'2026-10-13T00:00:00Z',sampleRate:.25,observationHours:24,maxNightlyCases:10,rubricVersion:'context-background-v1',privatePrompt:'private'};
 await writeFile(join(experimentDir,'spec.json'),JSON.stringify(spec));
 const switchFile=join(root,'feature-experiments','active.json');
 for(const [flags,state] of [[{},'running'],[{enrollmentEnabled:false},'paused'],[{enabled:false,reviewEnabled:false},'stopped']]) {
   await writeFile(switchFile,JSON.stringify({id:'trial',...flags})); clock+=61000;
   const view=await compactSessionMonitoring(await reader(),async()=>({run:{state:'idle'}}));
   assert.equal(view.contextExperiment.state,state); assert.deepEqual(view.contextExperiment.people,['A']);
   assert.equal(view.contextExperiment.reviewEnabled,flags.reviewEnabled!==false);
   assert.equal(view.contextExperiment.sampleRate,.25); assert(!JSON.stringify(view).includes('private'));
 }
 await writeFile(join(experimentDir,'spec.json'),JSON.stringify({...spec,mode:'aa'})); clock+=61000;
 assert.equal((await reader()).contextExperiment.mode,'aa');
 await writeFile(switchFile,'broken'); clock+=61000;
 assert.deepEqual((await reader()).contextExperiment,{state:'unavailable'});
 const projectionFile=join(root,'projections.json');
 const options={configDir:root,runsDir:join(root,'runs'),sessionsFile:join(root,'sessions.json'),includeSamples:true,projectionFile,getPeople:async()=>[],getUsage:async ({days})=>{assert.equal(days,14);return {runCount:1,topRuns:[ledger],bySession:[]};}};
 const populated=await createSessionMonitoringReader(options)({days:14});assert.equal(populated.samples.length,1);
 const cache=await readFile(projectionFile,'utf8');assert(!cache.includes('private'));assert.equal(JSON.parse(cache).version,2);
 const restarted=await createSessionMonitoringReader(options)({days:14});assert.equal(restarted.coverage.bytesRead,0);assert.equal(restarted.samples[0].metrics.injectionChars,3);
 await writeFile(join(root,'runs','r1','manifest.json'),JSON.stringify({id:'r1',sessionId:'s1',modelContext:'changed'}));
 const corrected=await createSessionMonitoringReader(options)({days:14});assert.equal(corrected.samples[0].metrics.injectionChars,7,'source edits invalidate durable projections');
 console.log('monitoring sessions: ownership, phase pairing, missing data, cohorts, sample bounds, read cache and privacy passed');
}finally{await rm(root,{recursive:true,force:true});}
