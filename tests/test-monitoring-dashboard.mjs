import './isolate-test-environment.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { businessStart, businessDate, BUSINESS_OFFSET, injectionSources, buildAgentDashboard } from '../chat/monitoring-dashboard.mjs';
import { projectRequest, projectInjection, runMeasurement, createSessionMonitoringReader } from '../chat/monitoring-sessions.mjs';
import { queryUsageLedger, buildUsageLedgerRecord } from '../chat/usage-ledger.mjs';
const at = Date.parse('2026-10-14T21:00:00Z');
assert.equal(businessDate(businessStart(at-1)), '2026-10-14');
assert.equal(businessDate(businessStart(at)), '2026-10-15');
const manifest = { id:'r',sessionId:'s',modelContext:'## A\n\n中文🙂\n\n---\n\n## B\n\nx',modelContextSlots:[{id:'a',title:'A'},{id:'b',title:'B'}] };
const source = injectionSources(manifest);
assert.equal(source.reduce((n,s)=>n+s.chars,0), [...manifest.modelContext].length);
assert(!JSON.stringify(source).includes('中文'));
const ledger={runId:'r',sessionId:'s',ts:new Date(at).toISOString()};
const run={id:'r',sessionId:'s',state:'completed'};
const raw={requestId:'q',runId:'r',sessionId:'s',acceptedAt:new Date(at).toISOString(),settledAt:new Date(at+1000).toISOString(),options:{sourceContext:{connector:'feishu'}},deliveries:[
  {kind:'content',connector:'feishu',surfaceKind:'opening',state:'delivered',createdAt:at+10,deliveredAt:at+20},
  {kind:'content',connector:'feishu',surfaceKind:'final',state:'delivered',createdAt:at+1000,deliveredAt:at+2000},
  {kind:'content',connector:'feishu',surfaceKind:'final',state:'delivered',createdAt:at+1000,deliveredAt:at+3000},
]};
const sample=runMeasurement(ledger,run,projectRequest(raw),projectInjection(manifest));
assert.equal(sample.metrics.finalDeliveryMs,3000);
assert.equal(sample.metrics.injectionChars,[...manifest.modelContext].length);
assert.equal(runMeasurement(ledger,run,projectRequest({...raw,deliveries:raw.deliveries.map((d,i)=>i===2?{...d,state:'pending'}:d)})).metrics.finalDeliveryMs,null);
assert.equal(runMeasurement(ledger,{...run,state:'cancelled'},projectRequest(raw)).metrics.finalDeliveryMs,null);
assert.equal(runMeasurement(ledger,run,projectRequest({...raw,deliveries:raw.deliveries.map(d=>({...d,publicationRequestId:'foreign'}))})).metrics.finalDeliveryMs,null);
const dashboard=buildAgentDashboard({dailyTrend:{days:[]}},[{...sample,firstSessionRun:true}],at+4000,{});
assert.equal(dashboard.today.firstDeliveryMs,3000);
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
