import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const home = await mkdtemp(join(tmpdir(), 'remotelab-kickoff-'));
setIsolatedTestHome(home);
const dir = join(home, '.config/remotelab'), connectorDir = join(dir, 'feishu-connectors/bot');
await mkdir(connectorDir, { recursive: true });
await writeFile(join(dir, 'auth.json'), JSON.stringify({ version: 2, primaryPersonId: 'person_a', people: [
  { id: 'person_a', name: 'A', identities: [{ id: 'identity_a', kind: 'feishu', realm: 'bot', subjectId: 'a' }] },
  { id: 'person_b', name: 'B', identities: [{ id: 'identity_b', kind: 'feishu', realm: 'bot', subjectId: 'b' }] },
] }));
const origin = { connector: 'feishu', sourceRouteId: 'bot', target: { chatId: 'discussion', tenantKey: 'tenant',
  chatType: 'group', conversationKind: 'thread', chatMode: 'thread', threadId: 'omt_source', rootId: 'om_source', messageId: 'om_source', replyInThread: true } };
const config = { botId: 'bot', storageDir: connectorDir, groups: Object.fromEntries(['discussion', 'work'].map(id => [id,
  { participationMode: 'ambient', participationControls: true, participationStatusCard: false }])),
  projectLinks: [{ projectId: 'project', discussionChatId: 'discussion', workChatId: 'work', workChatName: 'Work group' }] };
await writeFile(join(connectorDir, 'config.json'), JSON.stringify(config));
// Deliberately no group-routing-pilot.json or personal opt-in.
await writeFile(join(dir, 'chat-sessions.json'), JSON.stringify([{ id: 'source', name: 'Discussion', folder: home, tool: 'fake', conversation: origin }]));
try {
  await (await import('../lib/auth-config.mjs')).loadAuthDocument({ persistMigration: false });
  const { requests } = await import('../chat/requests.mjs');
  const { findSessionMeta, mutateSessionMeta, withSessionsMetaMutation, loadSessionsMeta } = await import('../chat/session-meta-store.mjs');
  const { handleWorkKickoff: act, kickoffQuestionDecision: decide, acceptWorkKickoff: accept,
    validateWorkKickoffPlan: validate, recoverWorkKickoffs, KICKOFF_CHOICES } = await import('../chat/work-kickoff.mjs');
  const { recoverExecutionPlans, readExecutionPlans } = await import('../chat/work-execution-plans.mjs');
  const { createParticipationController } = await import('../connectors/feishu/participation-state.mjs');
  const { buildNativeQuestionCard } = await import('../connectors/feishu/native-question-cards.mjs');
  const { claimSourceDelivery, completeSourceDelivery, failSourceDelivery, resolveSourceDelivery, getSourceDelivery, listSourceDeliveries } = await import('../chat/source-deliveries.mjs');
  const mode = createParticipationController({ config: { ...config, sourceRouteId: 'bot' } }, { cancelSession: async () => {} });
  const options = { viewPersonId: 'person_a', initiatedByIdentityId: 'identity_a', feishuConnectorAuthenticated: true,
    messageRoutingPolicy: { mechanism: 'none' }, sourceDelivery: origin,
    sourceContext: { connector: 'feishu', sourceRouteId: 'bot', chatId: 'discussion', chatType: 'group',
      createTime: String(Date.now()), messageId: 'om_input', sender: { openId: 'a', senderType: 'user' } } };
  let inputCount = 0, creations = 0, submissions = 0;
  const input = async (extra = {}, text = 'human input') => (await requests.accept({ sessionId: 'source', requestId: 'input-' + ++inputCount,
    text, options: { ...options, ...extra }, runtimeSelection: { tool: 'fake', model: 'fixture' }, deliveryPlan: origin })).record;
  const api = {
    async createSession(folder, tool, name, extra) {
      const prior = (await loadSessionsMeta()).find(s => s.externalTriggerId === extra.externalTriggerId);
      if (prior) return prior;
      const s = { id: 'child' + ++creations, folder, tool, name, ...extra };
      await withSessionsMetaMutation(async (all, save) => { all.push(s); await save(all); }); return s;
    },
    async submitHttpMessage(sessionId, text, images, opts) {
      const result = await requests.accept({ sessionId, requestId: opts.requestId, text, options: opts,
        runtimeSelection: { tool: 'fake', model: 'fixture' }, deliveryPlan: opts.sourceDelivery });
      if (!result.duplicate) submissions++;
      return { requestId: result.record.requestId, run: { id: result.record.runId } };
    },
  };
  const body = goal => ({ action: 'propose', goal, plan: 'Read existing artifacts; no business writes', sources: 'Original discussion link', unresolved: 'None', acceptance: 'Evidence and limitations' });
  const propose = async goal => act(await input(), body(goal), api);
  const pending = p => ({ question: p.question.title, options: p.question.options.map(label => ({ label })), multiSelect: false });
  const answer = async (p, choice = KICKOFF_CHOICES[0], extra = {}) => {
    const decision = decide(await findSessionMeta('source'), pending(p), [choice]);
    assert(decision);
    return input({ nativeQuestionId: 'question:' + p.proposal.id, workKickoffDecision: decision, ...extra }, choice);
  };
  const plan = async p => (await readExecutionPlans(await findSessionMeta('source'))).find(plan => plan.workKickoff?.proposalId === p.proposal.id);
  const drain = async () => { for (let i = 0; i < 20; i++) {
    const c = await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'bot' }); if (!c) return;
    await completeSourceDelivery(c.delivery.id, c.leaseId, { messageId: 'om_' + c.delivery.sessionId, threadId: 'omt_' + c.delivery.sessionId }, api);
  } throw Error('outbox did not drain'); };

  const p = await propose('Concrete work');
  assert.equal(creations, 0); assert.equal(submissions, 0);
  const duplicate = await propose('Concrete work'); assert.equal(duplicate.proposal.id, p.proposal.id); assert(duplicate.duplicate);
  const card = buildNativeQuestionCard({ sessionId: 'source', runId: 'run', questionId: 'q' }, { state: 'pending', question: pending(p), deadline: null });
  const rendered = JSON.stringify(card);
  for (const value of ['目标', '已定方案', '来源', '未决项', '目标干活群', '验收', ...KICKOFF_CHOICES]) assert(rendered.includes(value));
  assert.equal(decide(await findSessionMeta('source'), { ...pending(p), question: 'Truncated preview' }, [KICKOFF_CHOICES[0]]), null);
  assert.equal(decide(await findSessionMeta('source'), pending(p), ['👍']), null);
  assert.equal(await accept(await input({}, '移交干活群并开工'), api), '');
  await assert.rejects(act(await input(), { action: 'approve', proposalId: p.proposal.id }, api), /native human answer/);
  await assert.rejects(accept(await answer(p, KICKOFF_CHOICES[0], { viewPersonId: 'person_b', initiatedByIdentityId: 'identity_b' }), api), /original requester/);
  assert.equal(creations, 0);
  const decision = await answer(p);
  await Promise.all([accept(decision, api), accept(decision, api)]);
  let execution = await plan(p), branch = execution.branches[0];
  assert.equal(creations, 1); assert.equal(submissions, 0);
  assert.equal((await findSessionMeta(branch.sessionId)).conversation.target.chatId, 'work');
  assert.equal((await findSessionMeta(branch.sessionId)).conversation.target.rootId, undefined);
  assert.equal(branch.state, 'pending');
  const claim = await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'bot' });
  await assert.rejects(completeSourceDelivery(claim.delivery.id, claim.leaseId, {}, api), /actual messageId/);
  await failSourceDelivery(claim.delivery.id, claim.leaseId, new Error('unknown provider response'));
  await recoverExecutionPlans(api); assert.equal(submissions, 0);
  await completeSourceDelivery(claim.delivery.id, claim.leaseId, { messageId: 'om_work', threadId: 'omt_work' }, api);
  await completeSourceDelivery(claim.delivery.id, claim.leaseId, { messageId: 'om_work', threadId: 'omt_work' }, api);
  assert.equal(submissions, 1); assert.equal(creations, 1);
  const childInput = await requests.byRequest(branch.sessionId, branch.requestId);
  assert.equal(childInput.deliveryPlan.target.threadId, 'omt_work');
  assert.match(childInput.text, /Evidence and limitations/);
  assert((await listSourceDeliveries({ sessionId: 'source' })).some(d => d.responseId.startsWith('plan-admission:') && /open_thread_id=omt_work/.test(d.text)));
  await drain();

  for (const choice of KICKOFF_CHOICES.slice(1)) {
    const declined = await propose(choice), before = creations;
    await accept(await answer(declined, choice), api);
    assert.equal(creations, before);
    const again = await propose(choice); assert.equal(again.question, null); assert.equal(again.proposal.id, declined.proposal.id);
  }
  const obsolete = await propose('Old packet'); await propose('Changed packet');
  assert.equal(decide(await findSessionMeta('source'), pending(obsolete), [KICKOFF_CHOICES[0]]), null);
  const changing = await propose('Mode changed'); const changingAnswer = await answer(changing);
  await mode.change(origin.target, 'listening', { controlId: 'listen' });
  await assert.rejects(propose('Listening invitation cannot propose'), /active participation/);
  await assert.rejects(accept(changingAnswer, api), /mode or target changed/);
  await mode.change(origin.target, 'active', { controlId: 'active' });
  await assert.rejects(accept(changingAnswer, api), /mode or target changed/);
  const refreshed = await propose('Mode changed');
  assert.notEqual(refreshed.question.title, changing.question.title, 'a new epoch must not let an old preview approve the new draft');
  assert.equal(decide(await findSessionMeta('source'), pending(changing), [KICKOFF_CHOICES[0]]), null);
  const queued = await propose('Pause after approval'); await accept(await answer(queued), api);
  const queuedBranch = (await plan(queued)).branches[0];
  await mode.change(origin.target, 'paused', { controlId: 'pause' });
  assert.equal(await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'bot' }), null);
  assert.equal((await getSourceDelivery(queuedBranch.topicDeliveryId)).state, 'cancelled');
  await assert.rejects(validate('source', queued.proposal.id), /mode changed/);
  await mode.change(origin.target, 'active', { controlId: 'resume' });

  const rejected = await propose('Definite send failure'); await accept(await answer(rejected), api);
  const rejectClaim = await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'bot' });
  await failSourceDelivery(rejectClaim.delivery.id, rejectClaim.leaseId, new Error('rejected'), { definiteFailure: true });
  const beforeRecovery = submissions;
  await recoverExecutionPlans(api); assert.equal(submissions, beforeRecovery);
  await resolveSourceDelivery(rejectClaim.delivery.id, { state: 'delivered', messageId: 'om_recovered', threadId: 'omt_recovered' }, api);
  assert.equal(submissions, beforeRecovery + 1); await drain();

  const crashed = await propose('Crash before Session creation');
  const crashAnswer = await answer(crashed);
  await assert.rejects(accept(crashAnswer, { ...api, createSession: async () => { throw Error('creation unavailable'); } }), /creation unavailable/);
  await recoverWorkKickoffs(api); await recoverExecutionPlans(api);
  assert((await plan(crashed)).branches[0].sessionId); await drain();
  const lostPlan = await propose('Crash before plan persistence');
  await mutateSessionMeta('source', s => { Object.assign(s.workAwareness.kickoffs.find(x => x.id === lostPlan.proposal.id), {
    state: 'approved', decisionRequestId: 'persisted-human-decision', choice: KICKOFF_CHOICES[0] }); return true; });
  await recoverWorkKickoffs(api); assert((await plan(lostPlan)).branches[0].sessionId); await drain();

  const late = await propose('Mode change while provider sends'); await accept(await answer(late), api);
  const lateClaim = await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'bot' });
  const beforeLate = submissions;
  await mode.change(origin.target, 'listening', { controlId: 'late-listen' });
  await assert.rejects(completeSourceDelivery(lateClaim.delivery.id, lateClaim.leaseId,
    { messageId: 'om_late', threadId: 'omt_late' }, api), /mode changed/);
  assert.equal((await getSourceDelivery(lateClaim.delivery.id)).state, 'delivered', 'retain real provider evidence even when execution is fenced');
  assert.equal(submissions, beforeLate, 'a late successful send cannot start execution after mode change');
  await mode.change(origin.target, 'active', { controlId: 'late-active' });
  await recoverExecutionPlans(api); assert.equal(submissions, beforeLate);

  const renamed = await propose('Registration changed'); const oldAnswer = await answer(renamed);
  await writeFile(join(connectorDir, 'config.json'), JSON.stringify({ ...config, projectLinks: [] }));
  await assert.rejects(accept(oldAnswer, api), /No registered/);
  await assert.rejects(propose('Missing mapping'), /No registered/);
  assert.equal((await loadSessionsMeta()).filter(s => s.id !== 'source').length, creations);
  console.log('WORK_KICKOFF_VERIFIED: native preview, explicit choices, identity, no pilot gate, dedupe, supersession, active epoch fence, cross-group topic receipt, unknown/failure recovery, no real sends.');
} finally { await rm(home, { recursive: true, force: true }); }
