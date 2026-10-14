import './isolate-test-environment.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { businessStart, businessDate, BUSINESS_OFFSET, injectionSources, buildAgentDashboard, readContextSource } from '../chat/monitoring-dashboard.mjs';
import { projectRequest, projectInjection, runMeasurement, createSessionMonitoringReader } from '../chat/monitoring-sessions.mjs';
import { queryUsageLedger, buildUsageLedgerRecord } from '../chat/usage-ledger.mjs';
assert.equal(await readContextSource('../auth.json'), null);
assert.equal(await readContextSource('constructor'), null);
assert.equal(await readContextSource('__proto__'), null);
assert.match(await readContextSource('strict_start_check'), /开工检查/);
const at = Date.parse('2026-10-14T21:00:00Z');
assert.equal(businessDate(businessStart(at-1)), '2026-10-14');
assert.equal(businessDate(businessStart(at)), '2026-10-15');
const manifest = { id:'r',sessionId:'s',modelContext:'## A\n\n中文🙂\n\n---\n\n## B\n\nx',modelContextSlots:[{id:'a',title:'A'},{id:'b',title:'B'}] };
const source = injectionSources(manifest);
assert.equal(source.reduce((n,s)=>n+s.chars,0), [...manifest.modelContext].length);
assert(!JSON.stringify(source).includes('中文'));
const ledger={runId:'r',sessionId:'s',ts:new Date(at).toISOString()};
const run={id:'r',sessionId:'s',state:'completed',startedAt:new Date(at+100).toISOString(),completedAt:new Date(at+1000).toISOString()};
const raw={requestId:'q',runId:'r',sessionId:'s',acceptedAt:new Date(at).toISOString(),settledAt:new Date(at+1000).toISOString(),preparedAt:new Date(at+50).toISOString(),options:{sourceContext:{connector:'feishu',createTime:String(at)}},deliveries:[
  {kind:'content',connector:'feishu',surfaceKind:'opening',state:'delivered',createdAt:at+10,deliveredAt:at+20},
  {kind:'content',connector:'feishu',surfaceKind:'final',state:'delivered',createdAt:at+1000,deliveredAt:at+2000},
  {kind:'content',connector:'feishu',surfaceKind:'final',state:'delivered',createdAt:at+1000,deliveredAt:at+3000},
]};
const sample=runMeasurement(ledger,run,projectRequest(raw),projectInjection(manifest));
assert.equal(sample.metrics.finalDeliveryMs,3000);
assert.equal(sample.metrics.firstResponseMs,20,'opening is the first visible reply, not final delivery');
assert.deepEqual(sample.metrics.journeyStages,{receive:0,prepare:50,launch:50,run:900,send:2000,total:3000});
for (const createTime of [undefined, 'invalid', String(at/1000), String(at+1)]) {
  const measured=runMeasurement(ledger,run,projectRequest({...raw,options:{sourceContext:{connector:'feishu',createTime}}}));
  assert.equal(measured.metrics.firstResponseMs,null,'missing or invalid sent time must not fall back to accepted time');
  assert.equal(measured.metrics.journeyStages,null);
}
for (const preparedAt of [undefined,new Date(at-1).toISOString(),new Date(at+101).toISOString()]) {
  const measured=runMeasurement(ledger,run,projectRequest({...raw,preparedAt}));
  assert.equal(measured.metrics.journeyStages,null);
  assert.equal(measured.metrics.firstResponseMs,20);
}
for (const change of [{nativeDispatchRunId:'r'},{options:{sourceContext:{connector:'web',createTime:String(at)}}},
  {deliveries:raw.deliveries.map(d=>({...d,state:'pending'}))},
  {deliveries:raw.deliveries.map(d=>({...d,publicationRequestId:'foreign'}))}]) {
  assert.equal(runMeasurement(ledger,run,projectRequest({...raw,...change})).metrics.firstResponseMs,null);
}
const beforeBoundary=runMeasurement(ledger,run,projectRequest({...raw,options:{sourceContext:{connector:'feishu',createTime:String(at-500)}}}));
const crossed=buildAgentDashboard({dailyTrend:{days:[]}},[beforeBoundary],at+4000,{});
assert.equal(crossed.today.firstResponse.count,0);
assert.equal(crossed.days.at(-2).meanFirstResponseMs,520);
assert.equal(crossed.days.at(-2).journeyStages.total.mean,3500);
assert.equal(crossed.today.meanDeliveryMs,3000,'existing delivery remains grouped by accepted date');

assert.deepEqual(sample.metrics.deliveryStages,{total:3000,wait:100,run:900,send:2000});
for (const changed of [{startedAt:null},{completedAt:null},{startedAt:new Date(at-1).toISOString()},{completedAt:new Date(at+4000).toISOString()}]) {
  const measured=runMeasurement(ledger,{...run,...changed},projectRequest(raw));
  assert.equal(measured.metrics.deliveryStages,null);
  assert.equal(measured.metrics.finalDeliveryMs,3000,'independent end-to-end timing remains valid');
}
assert.equal(sample.metrics.injectionChars,[...manifest.modelContext].length);
assert.equal(runMeasurement(ledger,run,projectRequest({...raw,deliveries:raw.deliveries.map((d,i)=>i===2?{...d,state:'pending'}:d)})).metrics.finalDeliveryMs,null);
assert.equal(runMeasurement(ledger,{...run,state:'cancelled'},projectRequest(raw)).metrics.finalDeliveryMs,null);
assert.equal(runMeasurement(ledger,run,projectRequest({...raw,deliveries:raw.deliveries.map(d=>({...d,publicationRequestId:'foreign'}))})).metrics.finalDeliveryMs,null);
const dashboard=buildAgentDashboard({dailyTrend:{days:[]}},[{...sample,firstSessionRun:true}],at+4000,{});
assert.equal(dashboard.today.firstDeliveryMs,3000);
assert.equal(dashboard.today.meanFirstResponseMs,20);
assert.equal(['receive','prepare','launch','run','send'].reduce((sum,k)=>sum+dashboard.today.journeyStages[k].mean,0),dashboard.today.journeyStages.total.mean);
assert.equal(buildAgentDashboard({dailyTrend:{days:[]}},[{...sample,background:true}],at+4000,{}).today.firstResponse.count,0);
assert.equal(dashboard.today.deliveryStages.run.mean,900);
assert.equal(dashboard.today.firstDeliveryStages.wait.count,1);
const mixed=buildAgentDashboard({dailyTrend:{days:[]}},[
  {...sample,firstSessionRun:true},
  {...sample,firstSessionRun:false,metrics:{...sample.metrics,finalDeliveryMs:6000,deliveryStages:{total:6000,wait:1000,run:2000,send:3000}}},
  {...sample,firstSessionRun:false,metrics:{...sample.metrics,deliveryStages:null}},
  {...sample,background:true,metrics:{...sample.metrics,deliveryStages:{total:100,wait:10,run:30,send:60}}},
],at+4000,{}).today;
assert.equal(mixed.delivery.count,3);
assert.equal(mixed.deliveryStages.run.count,2);
assert.equal(mixed.deliveryStages.total.mean,4500);
assert.equal(['wait','run','send'].reduce((sum,k)=>sum+mixed.deliveryStages[k].mean,0),mixed.deliveryStages.total.mean);
assert.equal(mixed.firstDeliveryStages.total.mean,3000);
assert.equal(dashboard.days[0].deliveryStages.run.mean,null);
assert.equal(dashboard.days[0].meanInjectionChars,null);
assert.equal(dashboard.today.totalTokens,null);

const root=await mkdtemp(join(tmpdir(),'agent-dashboard-'));
try {
  await mkdir(join(root,'ledger'));
  const records=[at-1,at,at+100].map((t,i)=>buildUsageLedgerRecord({session:{id:'s'+i},run:{id:'r'+i,state:'completed',completedAt:new Date(t).toISOString()},usageEvent:{inputTokens:10,outputTokens:2},manifest:{}}));
  await writeFile(join(root,'ledger','2026-10-14.jsonl'),records.map(JSON.stringify).join('\n')+'\n');
  const usage=await queryUsageLedger({ledgerDir:join(root,'ledger'),startMs:at,endMs:at+1000,includeDailyTrend:true,includeTrendRuns:true,dailyBoundaryOffsetMs:BUSINESS_OFFSET,dailyTimezoneOffsetMs:8*3600000,dailyTimezone:'Asia/Shanghai',top:1});
  assert.equal(usage.runCount,2);assert.equal(usage.dailyTrend.days.at(-1).runCount,2);
  assert.equal(usage.dailyTrend.days.at(-2).runCount,1);
  assert.equal(usage.dailyTrend.days.at(-1).totalTokens,24);
  assert.equal(usage.trendRuns.length,3); // Aggregation independent of top-N display.
  assert.equal(usage.dailyTrend.days.at(-1).day,'2026-10-15');
  await mkdir(join(root,'chat-history','s','events'),{recursive:true});
  await writeFile(join(root,'chat-history','s','events','000000001.json'),JSON.stringify({type:'message',role:'user',runId:'older-run',content:'private'}));
  await mkdir(join(root,'runs','r'),{recursive:true});
  await writeFile(join(root,'runs','r','manifest.json'),JSON.stringify(manifest));
  await writeFile(join(root,'runs','r','status.json'),JSON.stringify({...run,requestId:'q'}));
  await writeFile(join(root,'sessions.json'),JSON.stringify([{id:'s'}]));
  const {createHash}=await import('node:crypto'); const key=createHash('sha256').update(JSON.stringify(['s','q'])).digest('hex').slice(0,24);
  await mkdir(join(root,'requests','archive'),{recursive:true});await writeFile(join(root,'requests','archive',key+'.json'),JSON.stringify(raw));
  const reader=createSessionMonitoringReader({configDir:root,runsDir:join(root,'runs'),sessionsFile:join(root,'sessions.json'),getPeople:async()=>[],now:()=>at+4000,getUsage:async()=>({window:{start:new Date(at).toISOString()},runCount:1,trendRunCount:1,trendRuns:[ledger],bySession:[],dailyTrend:{days:[]}})});
  const data=await reader({dashboard:true});
  assert.equal(data.agentDashboard.today.firstRuns,0,'first record in window must not become first Session run');
  assert.equal(data.agentDashboard.today.meanDeliveryMs,3000);
  assert(!JSON.stringify(data).includes('private'));
} finally { await rm(root,{recursive:true,force:true}); }
console.log('agent dashboard: 05:00 boundary, Unicode sizes, final receipts, first-ever Session run, gaps and aggregate coverage passed');
