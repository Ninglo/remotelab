import './isolate-test-environment.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRecentErrorMonitor } from '../lib/recent-errors.mjs';
import { dispatchRecentErrorAlerts, groupErrorLine } from '../chat/recent-error-alerts.mjs';
import { enqueueSourceDelivery, claimSourceDelivery, completeSourceDelivery } from '../chat/source-deliveries.mjs';

const tmp = await mkdtemp(join(tmpdir(),'recent-error-alert-test-'));
try {
  let now=Date.parse('2026-11-27T06:00:00Z');
  const since=now, monitor=createRecentErrorMonitor({file:join(tmp,'alerts'),now:()=>now});
  const config={ enabled:true, chatId:'oc_fixture', profile:'bot-2' };
  const flags={enabled:true,groupAlerts:{...config,enabledAt:new Date(since).toISOString()}};
  const line='Detached runner disappeared before writing a result';
  let analyses=0, sends=0;
  const record=async(id,attempt='terminal',at=now)=>monitor.record('run-result',{operation:id,attempt,at,error:line});
  const run=overrides=>dispatchRecentErrorAlerts({monitor,now:()=>now,loadConfig:async()=>flags,loadMonitoring:async()=>config,
    verify:async config=>config.chatId==='oc_fixture', analyze:async evidence=>{
      analyses++;
      assert.deepEqual(evidence.events.map(e=>e.diagnostic),[line,line,line]);
      assert.equal(evidence.source,'会话执行');
      return {cause:'可能是执行进程异常终止，尚未核实',direction:'对照退出状态和结果写入顺序'};
    },send:async request=>{sends++;return enqueueSourceDelivery(request);},...overrides});
  for(const id of ['old-a','old-b','old-c'])await record(id,'terminal',now-1000);
  await run(); assert.equal(analyses,0,'no initial backlog');
  await record('a'); await record('a','retry-a'); await record('a','retry-b');
  now+=1000; await record('b'); await run(); assert.equal(analyses,0,'retries do not trigger');
  now+=1000; await record('c');
  config.enabled=false; await run(); assert.equal(sends,0,'monitoring mute'); config.enabled=true;
  const denied=await run({verify:async()=>false}); assert.equal(denied.skipped,'target-unverified');
  assert.equal(analyses,1); assert.equal(sends,0);
  const queued=await run(); assert.equal(analyses,1); assert.equal(sends,1);
  const { delivery, leaseId }=await claimSourceDelivery({connector:'feishu',sourceRouteId:'bot-2'});
  assert.equal(delivery.id,queued.queued); assert.equal(delivery.target.chatId,'oc_fixture');
  assert.match(delivery.text,/同类报错 · 3 次/); assert.equal(delivery.text.split(line).length-1,3);
  assert.match(delivery.text,/北京时间/); assert.match(delivery.text,/可能原因：可能是执行进程异常终止/); assert.match(delivery.text,/修改建议：对照/);
  await completeSourceDelivery(delivery.id,leaseId,{messageId:'om_fixture'});
  await run(); assert.equal(sends,1); assert.equal(analyses,1);
  // More identical occurrences in the same rolling window do not spam the group.
  now+=1000; for(const id of ['d','e','f'])await record(id);
  await run(); assert.equal(sends,1);
  now+=86400_000+1; for(const id of ['g','h','i'])await record(id);
  config.chatId='oc_changed'; await run(); config.chatId='oc_fixture'; assert.equal(sends,1,'changed target is not authorized');
  await run({analyze:async()=>{throw Error('model offline');}}); assert.equal(sends,2);
  const fallback=await claimSourceDelivery({connector:'feishu',sourceRouteId:'bot-2'});
  assert.match(fallback.delivery.text,/本次 Agent 未返回可用分析/);
  assert.equal(groupErrorLine('ETIMEDOUT token=not-shareable'),'ETIMEDOUT');
  assert.equal(groupErrorLine('Customer-provided contents that must not leave the session'),'');
  console.log('recent error alerts: third independent error + Agent advice, target and mute checks, original outbox, receipts, cooldown, privacy and fallback passed');
} finally { await rm(tmp,{force:true,recursive:true}); }
