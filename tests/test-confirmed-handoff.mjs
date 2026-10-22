import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const home = await mkdtemp(join(tmpdir(), 'confirmed-handoff-'));
setIsolatedTestHome(home);
process.env.REMOTELAB_MEMORY_WRITEBACK = 'off';
const dir = join(home, '.config/remotelab'), bin = join(home, 'bin');
await mkdir(dir, { recursive: true }); await mkdir(bin);
await writeFile(join(dir, 'auth.json'), JSON.stringify({ version: 2, primaryPersonId: 'a', people: [
  { id: 'a', name: 'A', identities: [{ id: 'ia', kind: 'web', subjectId: 'a' }] },
  { id: 'b', name: 'B', identities: [{ id: 'ib', kind: 'web', subjectId: 'b' }] },
] }));
const groups = ['source', 'destination'].map(chatId => ({ sourceRouteId: 'bot', chatId, tenantKey: 'tenant', folder: home, activatedAt: '2026-01-01T00:00:00Z' }));
const config = { version: 2, enabled: true, personIds: ['a', 'b'], crossGroupSync: true, trialId: 'test', groups };
await writeFile(join(dir, 'group-routing-pilot.json'), JSON.stringify(config));
const conversation = chatId => ({ connector: 'feishu', sourceRouteId: 'bot', target: {
  chatId, tenantKey: 'tenant', chatType: 'group', conversationKind: 'thread', messageId: 'root-' + chatId,
  rootId: 'root-' + chatId, replyInThread: true, participationEpoch: 'source-epoch' } });
const source = { id: 'source', name: 'memory task', folder: home, conversation: conversation('source'), tool: 'fake-native' };
const target = { id: 'target', name: 'settings card', folder: home, conversation: conversation('destination'), tool: 'fake-batch',
  workSummary: { goal: 'settings card descriptions' } };
await writeFile(join(dir, 'chat-sessions.json'), JSON.stringify([source, target]));
await writeFile(join(dir, 'tools.json'), JSON.stringify([
  { id: 'fake-native', name: 'Fixture native', command: 'fake-native', runtimeFamily: 'codex-json', inputMode: 'native', promptMode: 'bare-user' },
  { id: 'fake-batch', name: 'Fixture batch', command: 'fake-batch', runtimeFamily: 'codex-json', promptMode: 'bare-user' },
]));
const fixture = await readFile(new URL('./fixtures/native-codex-app-server.cjs', import.meta.url), 'utf8');
await writeFile(join(bin, 'fake-native'), fixture.replaceAll("label: '简短'", "label: '确认转交'").replaceAll("question: '选择输出形式？'", "question: fs.readFileSync(path.join(root, 'preview'), 'utf8')"));
await writeFile(join(bin, 'fake-batch'), `#!/usr/bin/env node
console.log(JSON.stringify({type:'thread.started',thread_id:'test-thread'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',phase:'final_answer',text:'Target handled the confirmed task.'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
`);
await chmod(join(bin, 'fake-native'), 0o755); await chmod(join(bin, 'fake-batch'), 0o755);
process.env.PATH = bin + ':' + process.env.PATH;
await (await import('../lib/auth-config.mjs')).loadAuthDocument({ persistMigration: false });
const { requests } = await import('../chat/requests.mjs');
const { findSessionMeta, mutateSessionMeta } = await import('../chat/session-meta-store.mjs');
const { routeGroupWork, acceptGroupSync, readGroupRoutingState, routingQuestionDecision } = await import('../chat/group-routing.mjs');
const { routingDiscovery } = await import('../chat/work-routing-discovery.mjs');
const manager = await import('../chat/session-manager.mjs');
const { readNativeQuestion } = await import('../chat/native-user-questions.mjs');
const { runDir } = await import('../chat/runs.mjs');
const options = { viewPersonId: 'a', initiatedByIdentityId: 'ia', feishuConnectorAuthenticated: true,
  sourceContext: { connector: 'feishu', sourceRouteId: 'bot', chatId: 'source', chatType: 'group',
    messageId: 'human', createTime: String(Date.now()), sender: { senderType: 'user', openId: 'a' } },
  sourceDelivery: source.conversation,
  messageRoutingPolicy: { version: 1, mechanism: 'experimental', trialVersion: 2, trialId: 'test', personId: 'a' } };
const input = async (id, extra = {}) => (await requests.accept({ sessionId: source.id, requestId: id,
  text: 'Please improve settings card descriptions', options: { ...options, ...extra }, deliveryPlan: source.conversation })).record;
const body = { mode: 'handoff', targetSessionId: target.id, task: 'Improve the settings card descriptions', reason: 'Sent in the memory task by mistake' };
async function until(predicate) {
  const deadline = Date.now() + 20000; let delay = 25;
  do { const value = await predicate(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, delay)); delay = Math.min(500, delay * 2);
  } while (Date.now() < deadline);
  throw Error('Synthetic handoff runtime timed out');
}
try {
  const original = await input('original');
  await requests.mutate(original.key, r => ({ ...r, images: [{ name: 'screenshot.png', path: '/fixture/image.png' }] }));
  const draft = await routeGroupWork(original, body);
  assert.match(draft.preview, /screenshot.png/);
  assert.match(draft.preview, /Please improve settings/);
  assert.equal(routingQuestionDecision(await findSessionMeta(source.id), { question: 'unrelated question' }, ['确认转交']), '');
  assert.equal(routingQuestionDecision(await findSessionMeta(source.id), { question: draft.preview }, ['好']), '');
  assert.equal(await requests.byRequest(target.id, 'routing-handoff:' + draft.proposal.id), null, 'draft never dispatches');
  await assert.rejects(routeGroupWork(original, { mode: 'handoff', proposalId: draft.proposal.id }), /already human-approved/);
  assert.equal((await routeGroupWork(original, body)).proposal.id, draft.proposal.id);
  const other = await input('other-person', { viewPersonId: 'b', initiatedByIdentityId: 'ib' });
  await assert.rejects(acceptGroupSync({ ...other, text: draft.confirmation }), /original requester/);
  const reject = await input('reject');
  await acceptGroupSync({ ...reject, text: draft.rejection });
  assert.equal((await readGroupRoutingState(await findSessionMeta(source.id))).proposals[0].state, 'rejected');
  const stale = await routeGroupWork(await input('stale'), body);
  await mutateSessionMeta(target.id, s => { s.workSummary.goal = 'changed task'; return true; });
  await assert.rejects(acceptGroupSync({ ...await input('stale-confirm'), text: stale.confirmation }), /已变化/);
  await mutateSessionMeta(target.id, s => { s.workSummary.goal = target.workSummary.goal; return true; });
  const reads = [];
  const discovery = await routingDiscovery(source, 'a', { query: 'settings card descriptions', sessions: [source, target,
    { ...target, id: 'outside', conversation: conversation('not-registered') }], history: async (id, opts) => {
      reads.push(id); assert.equal(opts.metadataOnly, true); return { lastUserMessageAt: 123 };
    } });
  assert.equal(discovery.catalog.length, 2); assert.deepEqual(reads, ['target']);
  assert.equal(discovery.candidates[0].transfer, 'explicit-instruction-or-confirmed-draft');
  assert.equal(discovery.candidates[0].group.chatId, 'destination');
  const changed = await routingDiscovery(source, 'a', { query: 'settings card descriptions', sessions: [source, { ...target, workAwareness: { works: [{ id: 'old', goal: target.workSummary.goal, status: 'completed', updatedAt: '2026-01-01T00:00:00Z' }] } }], history: async () => ({ lastUserMessageAt: Date.now() }) });
  assert.equal(changed.candidates[0].matchedWorkStatus, 'completed');
  assert.equal(changed.candidates[0].status, 'idle', 'later input does not inherit a historical completion stamp');
  // Attachment fidelity, unknown admission retry, and receipt recovery use the
  // same durable stores without materializing a synthetic filesystem image.
  const retryOriginal = await input('retry-original');
  await requests.mutate(retryOriginal.key, r => ({ ...r, images: [{ name: 'original.png', path: '/fixture/image.png' }] }));
  const retryDraft = await routeGroupWork(retryOriginal, body);
  const retryConfirm = { ...await input('retry-confirm'), text: retryDraft.confirmation };
  let admissions = 0, deliveryFails = true;
  const stub = {
    submitHttpMessage: async (sessionId, text, images, supplied) => {
      const accepted = await requests.accept({ sessionId, requestId: supplied.requestId, text,
        images: supplied.preSavedAttachments, options: supplied, deliveryPlan: supplied.sourceDelivery });
      if (!accepted.duplicate) {
        admissions++;
        await mutateSessionMeta(target.id, s => { s.workAwareness = { intents: [{ id: 'admission-changed-intent' }] }; return true; });
        throw Error('lost admission response');
      }
      return { requestId: accepted.record.requestId, run: { id: accepted.record.runId } };
    },
    enqueueSourceDelivery: async () => { if (deliveryFails) throw Error('receipt temporarily unavailable'); return { id: 'receipt' }; },
  };
  await assert.rejects(acceptGroupSync(retryConfirm, stub), /lost admission/);
  assert.equal((await requests.get(retryOriginal.key)).routingHandoff.state, 'reserved');
  await assert.rejects(acceptGroupSync(retryConfirm, stub), /receipt temporarily/);
  deliveryFails = false;
  await routeGroupWork(retryOriginal, { mode: 'handoff', proposalId: retryDraft.proposal.id }, stub);
  assert.equal(admissions, 1);
  const copied = await requests.byRequest(target.id, 'routing-handoff:' + retryDraft.proposal.id);
  assert.deepEqual(copied.images, [{ name: 'original.png', path: '/fixture/image.png' }]);
  assert.equal(copied.options.initiatedByIdentityId, 'ia');
  await requests.settle(copied.key, { state: 'completed', payload: { text: '', attachments: [] } });
  await requests.mutate(copied.key, r => ({ ...r, releasedAt: new Date().toISOString(), postCompletionPending: false }));
  // Exercise the real native pending question, numeric button answer, routing
  // decision and batch target completion. No models, live config or messages.
  const runtimeDraft = await routeGroupWork(await input('runtime-original'), body);
  for (const id of ['original', 'other-person', 'reject', 'stale', 'stale-confirm', 'runtime-original', 'retry-original', 'retry-confirm']) {
    const r = await requests.byRequest(source.id, id);
    await requests.settle(r.key, { state: 'completed', payload: { text: '', attachments: [] } });
    await requests.mutate(r.key, v => ({ ...v, releasedAt: new Date().toISOString(), postCompletionPending: false }));
  }
  await writeFile(join(home, 'preview'), runtimeDraft.question.title);
  const root = await manager.submitHttpMessage(source.id, 'ASK_NATIVE_QUESTION', [], {
    ...options, requestId: 'ask-owner', tool: 'fake-native' });
  const question = await until(async () => {
    const q = await readNativeQuestion(runDir(root.run.id)); return q?.state === 'pending' && q;
  });
  assert.equal(question.question.options[0].label, '确认转交');
  assert.equal(question.question.question, runtimeDraft.preview);
  assert.equal(await requests.byRequest(target.id, 'routing-handoff:' + runtimeDraft.proposal.id), null);
  const replyOptions = { ...options, requestId: 'feishu-question:confirmed', nativeQuestionId: question.id,
    nativeQuestionAnswerSource: 'control', sourceContext: { ...options.sourceContext, createTime: String(Date.now()), messageType: 'interactive' } };
  const answer = await manager.submitHttpMessage(source.id, '1', [], replyOptions);
  const answered = await requests.byRequest(source.id, answer.requestId);
  assert.equal(answered.options.routingDecisionText, runtimeDraft.confirmation, 'server resolves numeric choice against actual pending question');
  const completed = await until(async () => {
    const p = (await readGroupRoutingState(await findSessionMeta(source.id))).proposals.find(p => p.id === runtimeDraft.proposal.id);
    return p.state === 'return-queued' && p;
  });
  const admitted = await requests.byRequest(target.id, 'routing-handoff:' + runtimeDraft.proposal.id);
  assert.equal(admitted.options.viewPersonId, 'a'); assert.equal(admitted.options.initiatedByIdentityId, 'ia');
  assert.equal(admitted.deliveryPlan.target.chatId, 'destination');
  assert.equal(admitted.deliveryPlan.target.participationEpoch, undefined);
  assert.equal(admitted.result.state, 'completed');
  assert.equal(completed.returnDeliveryState, 'pending'); assert.equal(completed.admissionDeliveryState, 'pending');
  const result = await requests.byRunId(completed.returnRunId);
  assert.equal(result.deliveries[0].target.chatId, 'source');
  assert.match(result.deliveries[0].text, /Target handled/);
  const again = await manager.submitHttpMessage(source.id, '1', [], replyOptions);
  assert.equal(again.duplicate, true, 'repeated callback preserves one admission');
  assert.equal((await requests.byRequest(target.id, admitted.requestId)).runId, admitted.runId);
  console.log('CONFIRMED_HANDOFF_VERIFIED: bounded discovery; drafts/rejection/staleness; real native numeric confirmation; identity, destination scope, exactly-once admission and result return. No external send.');
} finally { await manager.killAll(); await rm(home, { recursive: true, force: true }); }
