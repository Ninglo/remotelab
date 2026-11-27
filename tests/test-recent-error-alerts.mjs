import { setIsolatedTestHome } from './isolate-test-environment.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const tmp = await mkdtemp(join(tmpdir(),'recent-error-alert-test-'));
setIsolatedTestHome(tmp);
try {
  const { createRecentErrorMonitor, FEISHU_ADMISSION_TIMEOUT, FEISHU_REPLY_UNASSIGNED } = await import('../lib/recent-errors.mjs');
  const { dispatchRecentErrorAlerts, groupErrorLine } = await import('../chat/recent-error-alerts.mjs');
  const { enqueueSourceDelivery, claimSourceDelivery, completeSourceDelivery } = await import('../chat/source-deliveries.mjs');
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
  assert.match(delivery.text,/同类报错 · 3 次/);
  assert.equal(delivery.text.split('\n').filter(row=>row.includes('北京时间') && row.endsWith(line)).length,3);
  assert.match(delivery.text,/北京时间/); assert.match(delivery.text,/可能原因：可能是执行进程异常终止/); assert.match(delivery.text,/修改建议：对照/);
  await completeSourceDelivery(delivery.id,leaseId,{messageId:'om_fixture'});
  await run(); assert.equal(sends,1); assert.equal(analyses,1);
  // More identical occurrences in the same rolling window do not spam the group.
  now+=1000; for(const id of ['d','e','f'])await record(id);
  await run(); assert.equal(sends,1);
  now+=86400_000+1; for(const id of ['g','h','i'])await record(id);
  config.chatId='oc_changed'; await run(); config.chatId='oc_fixture'; assert.equal(sends,1,'changed target is not authorized');
  await run({analyze:async()=>{throw Error('model offline');}}); assert.equal(sends,1,'no generic analysis alerts');
  for(const id of ['gate-a','gate-b','gate-c']) await monitor.record('schedule-gate',{
    operation:id, error:'Gate timed out after 30s', sessionId:'private_fixture_session', reference:'private_task',
  });
  await run({publicBase:'https://index.example/',analyze:async evidence=>{
    assert.match(evidence.confirmedCause,/30 秒/);
    assert(!JSON.stringify(evidence).includes('private_fixture_session'));
    throw Error('model offline');
  }});
  const gate=await claimSourceDelivery({connector:'feishu',sourceRouteId:'bot-2'});
  assert.match(gate.delivery.text,/已确认：前置检查脚本在 30 秒内没有返回/);
  assert.equal(gate.delivery.text.split('Gate timed out after 30s').length-1,3);
  const link=gate.delivery.text.match(/https:\/\/index\.example\/monitoring\/recent-error-source\?id=([a-f0-9]{64})/);
  assert(link); assert.equal(await monitor.sourceSession(link[1]),'private_fixture_session');
  assert(!gate.delivery.text.includes('private_fixture_session'));
  assert(!gate.delivery.text.includes('private_task'));
  await completeSourceDelivery(gate.delivery.id,gate.leaseId,{messageId:'om_gate_fixture'});
  for(const id of ['private-a','private-b','private-c']) await monitor.record('feishu-inbox',{
    operation:id, error:'Private text not suitable for publishing', sessionId:'private_fixture_session',
  });
  assert.equal((await run({analyze:async()=>assert.fail('no Agent for unshareable error')})).skipped,'insufficient-evidence');
  assert.equal(sends,2);
  for (const [source, error, expected] of [
    ['feishu-inbox', FEISHU_ADMISSION_TIMEOUT, /已确认：已进入任务受理路径/],
    ['run-result', FEISHU_REPLY_UNASSIGNED, /已确认：会话已结束/],
  ]) {
    for (let n=1;n<=2;n++) await monitor.record(source,{operation:`${source}-${n}`,error});
    const sendsBefore = sends;
    let modelCalls=0;
    const noModel = {analyze: async()=>{modelCalls++;throw Error('model offline');}};
    await run(noModel); assert.equal(sends,sendsBefore);
    await monitor.record(source,{operation:`${source}-3`,error});
    const alert = await run(noModel);
    const {delivery,leaseId} = await claimSourceDelivery({connector:'feishu',sourceRouteId:'bot-2'});
    assert.equal(alert.queued,delivery.id);
    assert.match(delivery.text,expected);
    await completeSourceDelivery(delivery.id,leaseId,{messageId:`om_${source}`});
    await run(noModel); assert.equal(sends,sendsBefore+1);
    assert.equal(modelCalls,0,'deterministic Feishu alerts must not call a model');
  }
  assert.equal(groupErrorLine('ETIMEDOUT token=not-shareable'),'ETIMEDOUT');
  assert.equal(groupErrorLine('Customer-provided contents that must not leave the session'),'');
  console.log('recent error alerts: third independent error + Agent advice, target and mute checks, original outbox, receipts, cooldown, privacy and fallback passed');
} finally { await rm(tmp,{force:true,recursive:true}); }
