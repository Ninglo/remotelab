import './isolate-test-environment.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecentErrorMonitor } from '../lib/recent-errors.mjs';
import { dispatchRecentErrorAlerts } from '../chat/recent-error-alerts.mjs';

const dir=await mkdtemp(join(tmpdir(),'recent-error-digest-'));
try {
  let now=Date.parse('2026-11-28T01:00:00Z');
  const boundary=now, day=86400_000;
  const monitor=createRecentErrorMonitor({file:join(dir,'fixture'),now:()=>now});
  const config={enabled:true,profile:'bot-2',chatId:'oc_fixture'};
  const flags={enabled:true,groupAlerts:{...config,enabledAt:new Date(boundary-day*4).toISOString(),mode:'digest'}};
  const target='bot-2:oc_fixture';
  const sent=[];
  let analyzed=0, delivered=false;
  const tick=()=>dispatchRecentErrorAlerts({monitor,now:()=>now,loadConfig:async()=>flags,loadMonitoring:async()=>config,
    verify:async()=>true,publicBase:'https://fixture.example',analyze:async()=>{ analyzed++; throw Error('offline'); },
    send:async payload=>{sent.push(payload); return {id:'fixture'};},readDelivery:async()=>delivered?{state:'delivered',deliveredMessageId:'om_fixture'}:null});
  const rec=(source,operation,at,error,more={})=>monitor.record(source,{operation,at,error,...more});
  await rec('schedule-gate','a',now-60_000,'Gate timed out after 5s');
  await rec('schedule-gate','a',now-50_000,'Gate timed out after 5s',{attempt:2});
  await rec('schedule-gate','b',now-1,'Gate timed out after 30s',{sessionId:'private_session_fixture'});
  await rec('schedule-gate','c',now,'Gate timed out after 30s');
  await rec('run-result','private',now-5,'private diagnostic /no-export');
  for(const [i,t] of [1,2,3].entries()) await rec('service-exit',`svc-${i}`,now-t,'abnormal_exit',{diagnostic:"Failed with result 'signal'."});
  await tick(); await tick();
  assert.equal(sent.length,1); assert.equal(analyzed,2);
  assert.match(sent[0].responseId,/recent-error-digest:bot-2:oc_fixture:2026-11-28/);
  assert.match(sent[0].text,/定时任务前置检查超时.*2 次.*阈值：5s／30s.*分析暂不可用/);
  assert.match(sent[0].text,/服务异常退出.*3 次/);
  assert.match(sent[0].text,/证据不足.*1 类 1 次/);
  assert.doesNotMatch(sent[0].text,/同类报错|private_session_fixture|no-export/);
  delivered=true; await tick(); await tick();
  assert.equal((await monitor.digestState(target,'2026-11-28')).row.receipt,'om_fixture');
  now+=day; await rec('schedule-gate','d',now-1,'Gate timed out after 5s'); await tick();
  assert.equal(sent.length,2); assert.match(sent[1].text,/定时任务前置检查超时.*2 次/);
  await tick(); now+=day; await tick();
  assert.equal((await monitor.digestState(target,'2026-11-30')).row.state,'empty');
  assert.equal(sent.length,2);
  flags.groupAlerts.mode='instant';
  for(const i of [1,2,3]) await rec('schedule-gate',`instant-${i}`,now-i,'Gate timed out after 5s');
  await tick(); assert.match(sent.at(-1).text,/同类报错 · 3 次/);
  console.log('recent error digest: half-open windows, distinct operations, privacy, analysis fallback, empty and delivered receipts, service-exit and instant rollback passed');
} finally { await rm(dir,{recursive:true,force:true}); }
