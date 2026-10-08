import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const home = await mkdtemp(join(tmpdir(), 'remotelab-routing-runtime-'));
setIsolatedTestHome(home);
process.env.REMOTELAB_MEMORY_WRITEBACK = 'off';
const dir = join(home, '.config/remotelab');
await mkdir(dir, { recursive: true });
await mkdir(join(home, 'bin'));
const executable = join(home, 'bin/fake-route');
await writeFile(executable, `#!/usr/bin/env node
(async () => {
if (process.argv.join(' ').includes('HOLD_REVIEW_FIXTURE')) {
 const fs = require('fs'); const gate = ${JSON.stringify(join(home, 'release'))};
 if (!fs.existsSync(gate)) await new Promise(resolve => { const watcher = fs.watch(${JSON.stringify(home)}, () => {
  if (fs.existsSync(gate)) { watcher.close(); resolve(); }
 }); if (fs.existsSync(gate)) { watcher.close(); resolve(); } });
}
console.log(JSON.stringify({type:'thread.started',thread_id:'test-thread'}));
console.log(JSON.stringify({type:'turn.started'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',phase:'final_answer',text:'复核完成：新信息影响原结论，建议更新假设。'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
})().catch(e => { console.error(e); process.exitCode = 1; });
`);
await chmod(executable, 0o755);
process.env.PATH = join(home, 'bin') + ':' + process.env.PATH;
await writeFile(join(dir, 'tools.json'), JSON.stringify([{ id: 'fake-route', name: 'Fixture', command: 'fake-route',
  runtimeFamily: 'codex-json', models: [{ id: 'fixture', label: 'Fixture' }],
  reasoning: { kind: 'enum', levels: ['low'], default: 'low' } }]));
await writeFile(join(dir, 'auth.json'), JSON.stringify({ version: 2, primaryPersonId: 'person_a', people: [
  { id: 'person_a', name: '甲', identities: [{ id: 'identity_a', kind: 'web', subjectId: 'a' }] },
] }));
await writeFile(join(dir, 'group-routing-pilot.json'), JSON.stringify({ version: 1, enabled: true,
  groups: [{ sourceRouteId: 'bot', chatId: 'pilot', tenantKey: 'tenant', folder: home }] }));
const { loadAuthDocument } = await import('../lib/auth-config.mjs');
await loadAuthDocument({ persistMigration: false });
const manager = await import('../chat/session-manager.mjs');
const { requests } = await import('../chat/requests.mjs');
const { recordWorkInput } = await import('../chat/work-awareness.mjs');
const { findSessionMeta, mutateSessionMeta } = await import('../chat/session-meta-store.mjs');
const { routeGroupWork, readGroupRoutingState } = await import('../chat/group-routing.mjs');
// A bounded observer, only synthetic detached processes, no provider or connector.
async function until(predicate) {
  const deadline = Date.now() + 15000;
  let delay = 25;
  do { const result = await predicate(); if (result) return result;
    await new Promise(resolve => setTimeout(resolve, delay)); delay = Math.min(500, delay * 2);
  } while (Date.now() < deadline);
  throw new Error('Synthetic routing run did not complete');
}
try {
  const origin = { connector: 'feishu', sourceRouteId: 'bot', target: { chatId: 'pilot', tenantKey: 'tenant',
    chatType: 'group', conversationKind: 'main', messageId: 'input-root' } };
  const runtime = { tool: 'fake-route', model: 'fixture', effort: 'low' };
  const opts = { ...runtime, viewPersonId: 'person_a', initiatedByIdentityId: 'identity_a',
    sourceContext: { connector: 'feishu', chatId: 'pilot' }, sourceDelivery: origin };
  const main = await manager.createSession(home, runtime.tool, 'Pilot', { ...runtime, conversation: origin, sourceId: 'feishu' });
  const { record: first } = await requests.accept({ sessionId: main.id, requestId: 'manual-input', text: '复核事项 A',
    options: opts, runtimeSelection: runtime, deliveryPlan: origin });
  await recordWorkInput(main, first);
  const route = await routeGroupWork(first, { mode: 'new', task: '核对事项 A', reason: '独立工作' });
  const target = await findSessionMeta(route.targetSessionId);
  assert.equal(target.conversation.target.rootId, 'input-root');
  const task = await until(async () => { const r = await requests.byRequest(target.id, 'routed:manual-input'); return r?.result && r; });
  assert.equal(task.result.state, 'completed');
  assert(task.deliveries.length > 0);
  assert(task.deliveries.every(d => d.target.rootId === 'input-root'));
  const draft = await routeGroupWork(first, { mode: 'sync', targetSessionId: target.id, task: '补充事实 X，请复核', reason: '影响原假设' });
  const confirmation = await manager.submitHttpMessage(main.id, draft.confirmation, [], { ...opts, requestId: 'human-confirm' });
  await until(async () => (await requests.byRunId(confirmation.run.id))?.result);
  const state = await until(async () => { const s = await readGroupRoutingState(await findSessionMeta(main.id));
    return s.proposals[0]?.returnDeliveryId && s; });
  const proposal = state.proposals[0];
  const review = await requests.byRequest(target.id, 'routing-sync:' + proposal.id);
  assert.equal(review.result.state, 'completed');
  assert.equal(review.options.nativeQuestionId, undefined);
  assert.equal(review.deliveries.length, 0, 'reconsideration does not publish in the target topic');
  assert.equal(proposal.returnDeliveryState, 'pending', 'no synthetic group messages are sent');
  const outbound = await requests.byRunId(proposal.returnRunId);
  assert.match(outbound.deliveries[0].text, /复核完成/);
  assert.equal(outbound.deliveries[0].target.messageId, 'input-root');
  // Queued reconsideration must fail visibly if a newer task changes the target.
  const hold = await manager.submitHttpMessage(target.id, 'HOLD_REVIEW_FIXTURE', [], {
    ...runtime, requestId: 'held-task', viewPersonId: 'person_a', initiatedByIdentityId: 'identity_a', suppressSourceDelivery: true,
  });
  await until(async () => (await requests.byRunId(hold.run.id))?.preparedAt);
  const { record: newSource } = await requests.accept({ sessionId: main.id, requestId: 'stale-source', text: '再核对一项',
    options: opts, runtimeSelection: runtime, deliveryPlan: origin });
  const staleDraft = await routeGroupWork(newSource, { mode: 'sync', targetSessionId: target.id, task: '复核旧假设', reason: '排队期间的新任务反例' });
  await manager.submitHttpMessage(main.id, staleDraft.confirmation, [], { ...opts, requestId: 'stale-human-confirm' });
  await mutateSessionMeta(target.id, session => { session.workAwareness.intents.push({ id: 'newer-human-task' }); return true; });
  await writeFile(join(home, 'release'), 'release');
  const failed = await until(async () => { const p = (await readGroupRoutingState(await findSessionMeta(main.id))).proposals[1];
    return p.returnDeliveryId && p; });
  assert.equal(failed.resultState, 'failed');
  assert.equal(failed.returnDeliveryState, 'pending');
  const failureReturn = await requests.byRunId(failed.returnRunId);
  assert.match(failureReturn.deliveries[0].text, /目标讨论已变化/);
  console.log('GROUP_ROUTING_RUNTIME_VERIFIED: actual admission, isolated worker, human approval dispatch, target completion hook and durable source outbox. No live model or Feishu send.');
} finally { await manager.killAll(); await rm(home, { recursive: true, force: true }); }
