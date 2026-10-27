import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../automation/trial/store.mjs';
import { newTask, definition } from '../automation/trial/model.mjs';
import { createEngine } from '../automation/trial/engine.mjs';

async function fixture(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'automation-trial-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createStore(root), calls = [], runs = new Map(); let now = Date.parse('2026-10-27T00:00:00Z');
  const runtime = {
    async session() { return 'session-fixture'; },
    async submit(session, prompt, requestId) { calls.push({ session, prompt, requestId }); const id = `run-${calls.length}`; runs.set(id, { id, state: 'running' }); return { id }; },
    async run(id) { return runs.get(id); },
    async receipt() { return { status: 'completed', summary: 'fixture result', output: 'fixture output' }; },
    async deliver(task, cycle, type, requestId) { return { requestId, channel: 'fixture' }; },
    ...extra,
  };
  const engine = createEngine(store, runtime, { clock: () => now });
  const task = newTask({ purpose: 'test task', cost: '仅估算，不设预算限制' }, {}, now); await store.save(task);
  return { store, runtime, task, calls, runs, engine, advance: ms => { now += ms; }, read: () => store.read(task.id) };
}
test('definition keeps agreed fields and cost never becomes a quota', () => {
  const d = definition({ purpose: 'test', cost: '预计一百万 Token', maxTokens: 1, monitoring: {} });
  assert.equal(d.cost, '预计一百万 Token'); assert.equal(d.maxTokens, undefined); assert.equal(d.monitoring.noProgressMinutes, 0);
  assert.throws(() => definition({ purpose: 'a', startsAt:'2026-10-28', endsAt:'2026-10-27' }));
});
test('creation does not run manual tasks; successful execution delivers an actual result receipt', async t => {
  const f = await fixture(t); await f.engine.tick(); assert.equal(f.calls.length, 0);
  await f.engine.action(f.task.id, 'run'); await f.engine.tick();
  f.runs.set('run-1', { state:'completed' }); await f.engine.tick();
  const c = (await f.read()).cycles[0]; assert.equal(c.status,'completed'); assert.equal(c.deliveries.result.state,'delivered');
});
test('process success with missing result invokes Agent repair, not business success', async t => {
  const f = await fixture(t,{ receipt:async()=>null });
  await f.engine.action(f.task.id,'run'); await f.engine.tick();f.runs.set('run-1',{state:'completed'});await f.engine.tick();await f.engine.tick();
  assert.equal((await f.read()).cycles[0].status,'repairing');assert.match(f.calls[1].prompt,/故障修复/);
});
test('two failed repairs create a human request and stop automatic attempts', async t => {
  const f = await fixture(t);await f.engine.action(f.task.id,'run');
  for(let i=1;i<=3;i++){await f.engine.tick();f.runs.set(`run-${i}`,{state:'failed',failureReason:'deterministic failure'});await f.engine.tick();}
  await f.engine.tick();const c=(await f.read()).cycles[0];assert.equal(f.calls.length,3);assert.equal(c.status,'needs_human');assert.equal(c.deliveries.human.state,'delivered');
});
test('new scheduled occurrence cannot wash away an unresolved earlier one', async t => {
  const f=await fixture(t);let task=await f.read();task.definition.schedule={kind:'cron',cron:'* * * * *',timezone:'UTC'};task.nextAt='2026-10-27T00:00:00Z';await f.store.save(task);
  await f.engine.tick();f.runs.set('run-1',{state:'failed'});f.advance(120_000);await f.engine.tick();assert.equal((await f.read()).cycles.length,1);
});
test('restart reuses persisted admission request instead of starting a duplicate', async t => {
  const f=await fixture(t);await f.engine.action(f.task.id,'run');let task=await f.read(),c=task.cycles[0];c.status='admitting';c.attempts=[{number:1,requestId:'stable-admission',admittedAt:new Date().toISOString()}];await f.store.save(task);
  const restarted=createEngine(f.store,f.runtime);await restarted.tick();assert.equal(f.calls[0].requestId,'stable-admission');assert.equal((await f.read()).cycles[0].attempts.length,1);
});
test('delivery failure retries delivery only, preserving result and execution', async t => {
  let count=0;const f=await fixture(t,{deliver:async()=>{if(++count===1)throw new Error('delivery unavailable');return{channel:'fixture'};}});
  await f.engine.action(f.task.id,'run');await f.engine.tick();f.runs.set('run-1',{state:'completed'});await f.engine.tick();assert.equal((await f.read()).cycles[0].status,'delivery_failed');
  await f.engine.action(f.task.id,'deliver');assert.equal((await f.read()).cycles[0].status,'completed');assert.equal(f.calls.length,1);
});
test('paused task does not start repair; expiry accepts in-flight result', async t => {
  const f=await fixture(t);await f.engine.action(f.task.id,'run');await f.engine.tick();await f.engine.action(f.task.id,'pause');f.runs.set('run-1',{state:'failed'});await f.engine.tick();await f.engine.tick();assert.equal(f.calls.length,1);
  await f.engine.action(f.task.id,'resume');await f.engine.tick();let task=await f.read();task.definition.endsAt='2026-10-27T00:00:01Z';await f.store.save(task);f.advance(2000);f.runs.set('run-2',{state:'completed'});await f.engine.tick();task=await f.read();assert.equal(task.state,'ended');assert.equal(task.cycles[0].status,'completed');
});
test('human input continues the same occurrence and retains prior evidence', async t => {
  const f=await fixture(t,{receipt:async()=>({status:'needs_human',summary:'missing input',humanAction:'提供来源文件'})});await f.engine.action(f.task.id,'run');await f.engine.tick();f.runs.set('run-1',{state:'completed'});await f.engine.tick();
  await f.engine.action(f.task.id,'continue',{answer:'文件已放在指定目录'});await f.engine.tick();const c=(await f.read()).cycles[0];assert.equal(c.attempts.length,2);assert.match(f.calls[1].prompt,/文件已放在指定目录/);assert.equal((await f.read()).cycles.length,1);
});
test('optional event-stall warning preserves running work and does not duplicate warning', async t => {
  let notices=0;const f=await fixture(t,{deliver:async()=>{notices++;return{channel:'fixture'};}});let task=await f.read();task.definition.monitoring.noProgressMinutes=1;await f.store.save(task);await f.engine.action(f.task.id,'run');await f.engine.tick();f.advance(61_000);await f.engine.tick();await f.engine.tick();assert.equal(notices,1);assert.equal((await f.read()).cycles[0].status,'running');
});

test('restart completes an interrupted delivery before a new cycle can start', async t => {
  const f=await fixture(t);await f.engine.action(f.task.id,'run');await f.engine.tick();
  let task=await f.read(),c=task.cycles[0];c.status='completed';c.result={output:'persisted result'};c.deliveries.result={state:'sending',requestId:'stable'};await f.store.save(task);
  await assert.rejects(f.engine.action(task.id,'run'));
  await f.engine.tick();assert.equal((await f.read()).cycles[0].deliveries.result.state,'delivered');assert.equal(f.calls.length,1);
});
test('a stall warning does not suppress a later request for human input', async t => {
  const notices=[];const f=await fixture(t,{deliver:async(t,c,type)=>{notices.push(type);return{channel:'fixture'};},receipt:async()=>({status:'needs_human',summary:'provide file'})});
  let task=await f.read();task.definition.monitoring.noProgressMinutes=1;await f.store.save(task);await f.engine.action(task.id,'run');await f.engine.tick();f.advance(61000);await f.engine.tick();f.runs.set('run-1',{state:'completed'});await f.engine.tick();assert.deepEqual(notices,['stall','human']);
});

test('a temporary observation outage remains visible and never duplicates execution', async t => {
  const f=await fixture(t);await f.engine.action(f.task.id,'run');await f.engine.tick();
  const original=f.runtime.run;f.runtime.run=async()=>{throw Error('control plane unavailable');};await f.engine.tick();assert.match((await f.read()).cycles[0].observationError,/unavailable/);assert.equal(f.calls.length,1);
  f.runtime.run=original;await f.engine.tick();assert.equal((await f.read()).cycles[0].observationError,undefined);assert.equal(f.calls.length,1);
});
