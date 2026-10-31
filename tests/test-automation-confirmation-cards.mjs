import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'automation-confirmation-'));
setIsolatedTestHome(home);
try {
  const { CONFIG_DIR } = await import('../lib/config.mjs');
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(join(CONFIG_DIR, 'tools.json'), JSON.stringify([{ id: 'codex', name: 'Fixture', command: process.execPath,
    runtimeFamily: 'codex-json', models: [{ id: 'auto' }, { id: 'gpt-6-astra' }, { id: 'gpt-6.1-sol' }],
    reasoning: { kind: 'enum', levels: ['low', 'medium', 'xhigh'], default: 'medium' } }]));
  const { updateAuthDocument } = await import('../lib/auth-config.mjs');
  await updateAuthDocument(doc => {
    doc.people = [{ id: 'person_alice', name: 'Alice', credentials: [],
      identities: [{ id: 'identity_alice', kind: 'feishu', realm: 'fixture', subjectId: 'alice' }] }];
    doc.primaryPersonId = 'person_alice';
  });
  const { createSession, getSession } = await import('../chat/session-manager.mjs');
  const { requests } = await import('../chat/requests.mjs');
  const { listSourceDeliveries } = await import('../chat/source-deliveries.mjs');
  const { getRecurringSchedule, updateRecurringSchedule, materializeDueRecurringSchedulesNow } = await import('../chat/recurring-schedules.mjs');
  const { getTrigger, createTrigger, ensureExecutionSession, updateTrigger } = await import('../chat/triggers.mjs');
  const { handleAutomationConfirmationRoutes } = await import('../chat/router-automation-confirmations.mjs');
  const { sendAutomationCard, handleAutomationCardAction, buildAutomationCard } = await import('../connectors/feishu/automation-cards.mjs');
  const { readAutomationConfirmation } = await import('../chat/automation-confirmations.mjs');
  const session = await createSession(home, 'codex', 'Original discussion', { initiatedByIdentityId: 'identity_alice', viewPersonId: 'person_alice',
    model: 'gpt-6-astra', effort: 'xhigh' });
  const plan = { connector: 'feishu', sourceRouteId: 'fixture', target: { chatId: 'chat', tenantKey: 'tenant',
    chatType: 'group', messageId: 'human-message', threadId: 'original-thread', conversationKind: 'thread', replyInThread: true } };
  await requests.accept({ sessionId: session.id, requestId: 'human', text: '请建立自动化', deliveryPlan: plan,
    options: { sourceDelivery: plan, viewPersonId: 'person_alice', initiatedByIdentityId: 'identity_alice', feishuConnectorAuthenticated: true } });
  // Exercise the actual HTTP handler and service boundary without a live server.
  const request = async (pathname, options = {}, authKind = 'service') => {
    const req = Readable.from(options.body === undefined ? [] : [JSON.stringify(options.body)]);
    req.method = options.method || 'GET';
    let result;
    const handled = await handleAutomationConfirmationRoutes({ req, res: {}, pathname, authSession: { authKind },
      writeJson: (_res, status, json) => { result = { response: { ok: status < 300, status }, json }; } });
    assert(handled); return result;
  };
  const gateState = join(home, 'gate-state.json');
  await writeFile(gateState, JSON.stringify({ trigger: false, reason: 'unchanged' }));
  const input = { key: 'ordinary', sourceSessionId: session.id, sourceRequestId: 'human', kind: 'recurring',
    title: 'Fixture automation', text: 'Inspect fixture and report.', output: '任务话题', everySeconds: 3600,
    runtimePolicy: 'fixed', tool: 'codex', model: 'gpt-6.1-sol', effort: 'medium',
    gate: { mode: 'script', runtime: 'node', source: `require('node:fs/promises').readFile(${JSON.stringify(gateState)}, 'utf8').then(text => process.stdout.write(text));` } };
  assert.equal((await request('/api/automation-confirmations', { method: 'POST', body: input }, 'web')).response.status, 403);
  assert.equal((await request('/api/automation-confirmations', { method: 'POST', body: { ...input, sourceRequestId: 'forged' } })).response.status, 400);
  assert.equal((await request('/api/automation-confirmations', { method: 'POST', body: { ...input, gate: { mode: 'script' } } })).response.status, 400);
  const propose = async body => {
    const result = await request('/api/automation-confirmations', { method: 'POST', body });
    assert.equal(result.response.status, 201, JSON.stringify(result.json)); return result.json.confirmation;
  };
  let record = await propose(input);
  assert.equal(record.phase, 'pending');
  assert.equal((await getRecurringSchedule(record.taskId)).enabled, false);
  assert.notEqual(record.executionSessionId, session.id);
  assert.equal((await getSession(record.executionSessionId)).internalRole, 'scheduled_execution');
  assert.equal((await getSession(record.executionSessionId)).model, 'gpt-6.1-sol');
  assert.equal((await getSession(record.executionSessionId)).effort, 'medium');
  assert.equal((await propose(input)).executionSessionId, record.executionSessionId);
  assert.equal((await request('/api/automation-confirmations', { method: 'POST', body: { ...input, text: 'changed' } })).response.status, 400);
  for (const patch of [{ model: 'gpt-6-astra' }, { gate: { mode: 'direct' } }]) {
    assert.equal((await request('/api/automation-confirmations', { method: 'POST', body: { ...input, ...patch } })).response.status, 400);
  }
  const deliveries = async (r, surface) => (await listSourceDeliveries({ sessionId: surface === 'source' ? r.sourceSessionId : r.executionSessionId }))
    .filter(d => d.automationControl?.key === r.key && d.automationControl.surface === surface);
  let created = 0, patched = 0;
  const messages = new Map(), expired = new Set();
  const send = async (args, reply) => {
    const id = `card-${++created}`;
    const target = reply ? messages.get(args.path.message_id) : null;
    const threadId = reply ? target?.thread_id || 'original-thread' : `thread-${created}`;
    messages.set(id, { message_id: id, thread_id: threadId, chat_id: reply ? target?.chat_id || 'chat' : args.data.receive_id,
      msg_type: 'interactive', content: args.data.content, parent: args.path?.message_id });
    return { code: 0, data: { message_id: id, thread_id: threadId } };
  };
  const app = { reply: args => send(args, true), create: args => send(args, false),
    patch: async args => { patched++; if (expired.has(args.path.message_id)) return { code: 230031, msg: 'expired' };
      messages.get(args.path.message_id).content = args.data.content; return { code: 0 }; },
    get: async args => ({ code: 0, data: { items: [messages.get(args.path.message_id)].filter(Boolean) } }) };
  const runtime = { config: { storageDir: join(home, 'connector'), sourceRouteId: 'fixture' }, appClient: { im: { v1: { message: app } } } };
  const sourceDelivery = (await deliveries(record, 'source'))[0];
  assert(sourceDelivery, 'metadata must survive native Request/source-delivery persistence');
  const sourceCard = await sendAutomationCard(runtime, sourceDelivery, { request });
  await sendAutomationCard(runtime, sourceDelivery, { request });
  assert.equal(created, 1);
  const { EventDispatcher } = await import('@larksuiteoapi/node-sdk');
  const dispatcher = new EventDispatcher({}).register({ 'card.action.trigger': data => handleAutomationCardAction(runtime, data, { request, authorize: async () => true }) });
  const action = (r, a, extra = {}) => dispatcher.invoke({ schema: '2.0', header: { event_type: 'card.action.trigger', event_id: 'event' }, event: {
    operator: { open_id: extra.openId || 'alice', tenant_key: extra.tenant || 'tenant' },
    context: { open_message_id: extra.messageId || sourceCard.messageId, open_chat_id: extra.chatId || 'chat' },
    action: { value: { namespace: 'automation-control', key: r.key, action: a, expanded: extra.expanded } } } }, { needCheck: false });
  for (const bad of [{ openId: 'bob' }, { tenant: 'other' }, { chatId: 'other' }, { messageId: 'forged' }]) {
    assert.equal((await action(record, 'confirm', bad)).toast.type, 'error');
  }
  assert.equal((await action(record, 'confirm')).toast.type, 'success');
  assert.equal((await getRecurringSchedule(record.taskId)).status, 'paused', 'receipt and binding precede activation');
  assert.equal((await action(record, 'confirm')).toast.type, 'success');
  const entryDelivery = (await deliveries(record, 'entry'))[0];
  assert(entryDelivery);
  const entryCard = await sendAutomationCard(runtime, entryDelivery, { request });
  record = await readAutomationConfirmation(record.key);
  assert.equal(record.phase, 'active');
  const schedule = await getRecurringSchedule(record.taskId);
  assert.equal(schedule.enabled, true);
  assert.equal(schedule.sessionTemplate.sessionId, record.executionSessionId);
  assert.equal(schedule.sessionTemplate.conversation.target.threadId, entryCard.thread_id);
  // The confirmed script runs without a model; only changed state admits the
  // chosen task runtime, independently of the original discussion's model.
  const admitted = [];
  const tick = async () => materializeDueRecurringSchedulesNow({ now: (await getRecurringSchedule(schedule.id)).nextRunAt,
    createScheduledTrigger: async data => { const trigger = await createTrigger(data); admitted.push(trigger); return trigger; } });
  assert.equal((await tick()).materialized, 0);
  assert.equal(admitted.length, 0);
  await writeFile(gateState, 'unavailable');
  assert.equal((await tick()).failed, 1);
  assert.equal((await getRecurringSchedule(schedule.id)).lastGateReason, 'gate_error');
  assert.equal(admitted.length, 0, 'a failed observation is not an unchanged-state success or a model admission');
  await writeFile(gateState, JSON.stringify({ trigger: true, reason: 'resource_ready', dedupeKey: 'resource-v1' }));
  assert.equal((await tick()).materialized, 1);
  const resolved = await ensureExecutionSession(admitted[0]);
  assert.equal(resolved.session.id, record.executionSessionId);
  assert.equal(resolved.trigger.executionRuntime.model, 'gpt-6.1-sol');
  assert.equal(resolved.trigger.executionRuntime.effort, 'medium');
  assert.equal((await getSession(session.id)).model, 'gpt-6-astra');
  assert.equal((await getSession(session.id)).effort, 'xhigh');
  await sendAutomationCard(runtime, entryDelivery, { request });
  assert.equal(created, 2, 'confirmation and delivery retries reuse both real messages');
  const activeReceipt = await readAutomationConfirmation(record.key);
  await writeFile(join(CONFIG_DIR, 'automation-confirmations', `${record.key}.json`), JSON.stringify({ ...activeReceipt, phase: 'confirming' }));
  await sendAutomationCard(runtime, entryDelivery, { request });
  assert.equal((await readAutomationConfirmation(record.key)).phase, 'active', 'crash after activation recovers without restarting or changing the task');
  await sendAutomationCard(runtime, sourceDelivery, { request });
  assert.match(messages.get(sourceCard.messageId).content, new RegExp(entryCard.thread_id));
  assert.equal((await action(record, 'details', { expanded: true })).toast.type, 'success');
  await sendAutomationCard(runtime, sourceDelivery, { request });
  assert.match(messages.get(sourceCard.messageId).content, /Inspect fixture/);
  await action(record, 'refresh');
  assert.equal((await readAutomationConfirmation(record.key)).expanded, true);
  // Two separate occurrences resolve to the same native execution Session.
  const occurrence = async n => createTrigger({ sourceSessionId: session.id, scheduleId: schedule.id,
    sessionTemplate: schedule.sessionTemplate, text: schedule.text, scheduledAt: new Date(Date.now() + n * 3600000).toISOString() });
  const first = await occurrence(1), second = await occurrence(2);
  assert.equal((await ensureExecutionSession(first)).session.id, record.executionSessionId);
  assert.equal((await ensureExecutionSession(second)).session.id, record.executionSessionId);
  const { createRun, getRun } = await import('../chat/runs.mjs');
  const { CHAT_TRIGGERS_FILE } = await import('../lib/config.mjs');
  const runningOccurrence = await occurrence(3);
  const run = await createRun({ status: { sessionId: record.executionSessionId, state: 'running' } });
  const injectRun = async (id, runId) => {
    const triggers = JSON.parse(await readFile(CHAT_TRIGGERS_FILE, 'utf8'));
    Object.assign(triggers.find(t => t.id === id), { status: 'delivered', runId, executionSessionId: record.executionSessionId });
    await writeFile(CHAT_TRIGGERS_FILE, JSON.stringify(triggers));
  };
  await injectRun(runningOccurrence.id, run.id);
  // Old-message updates fail, but cancellation commits before any provider call.
  expired.add(sourceCard.messageId);
  assert.equal((await action(record, 'stop')).toast.type, 'success');
  assert.equal((await getRecurringSchedule(record.taskId)).status, 'cancelled');
  assert.equal((await getTrigger(first.id)).status, 'cancelled');
  assert.equal((await getTrigger(second.id)).status, 'cancelled');
  assert.equal((await getRun(run.id)).cancelRequested, true, 'native current Run receives cancellation');
  assert.equal((await getTrigger(runningOccurrence.id)).status, 'delivered', 'admission receipt is retained');
  const replacement = await sendAutomationCard(runtime, sourceDelivery, { request });
  assert.notEqual(replacement.messageId, sourceCard.messageId);
  assert.equal(messages.get(replacement.messageId).parent, 'human-message');
  assert.match(messages.get(replacement.messageId).content, /已停止/);
  assert.equal((await action(record, 'confirm')).toast.type, 'error');
  assert.equal((await action(record, 'stop')).toast.type, 'success', 'old cards remain valid stop targets');
  // Stop wins against a delayed entry receipt; it cannot enable afterwards.
  const stopped = await propose({ ...input, key: 'stop-before-entry' });
  const stoppedCard = await sendAutomationCard(runtime, (await deliveries(stopped, 'source'))[0], { request });
  await action(stopped, 'confirm', { messageId: stoppedCard.messageId });
  await action(stopped, 'stop', { messageId: stoppedCard.messageId });
  const before = created;
  assert.equal((await sendAutomationCard(runtime, (await deliveries(stopped, 'entry'))[0], { request })).skipped, true);
  assert.equal(created, before);
  // Mutation between consent and the entry delivery must fail closed.
  const changed = await propose({ ...input, key: 'changed-before-entry' });
  const changedCard = await sendAutomationCard(runtime, (await deliveries(changed, 'source'))[0], { request });
  await action(changed, 'confirm', { messageId: changedCard.messageId });
  await updateRecurringSchedule(changed.taskId, { text: 'Unconfirmed new behavior' });
  await assert.rejects(sendAutomationCard(runtime, (await deliveries(changed, 'entry'))[0], { request }), /定义发生变化/);
  assert.equal((await getRecurringSchedule(changed.taskId)).enabled, false);
  // One-time tasks bind only via their internal confirmation operation. Public
  // trigger PATCH still cannot redirect an existing trigger.
  const { gate: _gate, ...onceInput } = input;
  const once = await propose({ ...onceInput, key: 'once', kind: 'one_time', scheduledAt: new Date(Date.now() + 3600000).toISOString() });
  assert.equal((await getTrigger(once.taskId)).status, 'paused');
  assert.equal((await getTrigger(once.taskId)).model, 'gpt-6.1-sol');
  await assert.rejects(updateTrigger(once.taskId, { sessionTemplate: schedule.sessionTemplate }), /immutable/);
  const onceCard = await sendAutomationCard(runtime, (await deliveries(once, 'source'))[0], { request });
  await action(once, 'confirm', { messageId: onceCard.messageId });
  await sendAutomationCard(runtime, (await deliveries(once, 'entry'))[0], { request });
  assert.equal((await getTrigger(once.taskId)).status, 'pending');
  assert.equal((await getTrigger(once.taskId)).sessionTemplate.conversation.target.chatId, 'chat');
  const onceRun = await createRun({ status: { sessionId: once.executionSessionId, state: 'running' } });
  await injectRun(once.taskId, onceRun.id);
  await action(once, 'stop', { messageId: onceCard.messageId });
  assert.equal((await getRun(onceRun.id)).cancelRequested, true);
  assert.equal((await getTrigger(once.taskId)).status, 'delivered');
  assert.equal((await readAutomationConfirmation(once.key)).phase, 'stopped');
  const automatic = await propose({ ...onceInput, key: 'auto-runtime', runtimePolicy: 'auto' });
  assert.equal((await getSession(automatic.executionSessionId)).model, 'auto', 'explicit Auto does not inherit Astra');
  const { runtimePolicy: _policy, tool: _tool, model: _model, effort: _effort, ...legacyInput } = onceInput;
  const legacy = await propose({ ...legacyInput, key: 'legacy-runtime' });
  assert.equal((await getSession(legacy.executionSessionId)).model, 'gpt-6-astra', 'legacy callers retain their prior behavior');
  // Recovery after activation committed but before its receipt was saved.
  const activeRecord = { ...record, phase: 'confirming' };
  await writeFile(join(CONFIG_DIR, 'automation-confirmations', `${record.key}.json`), JSON.stringify(activeRecord));
  await sendAutomationCard(runtime, entryDelivery, { request });
  assert.equal((await readAutomationConfirmation(record.key)).phase, 'stopped', 'cancelled native task never reactivates on receipt recovery');
  assert(patched > 0);
  assert.match(JSON.stringify(buildAutomationCard(await readAutomationConfirmation(once.key))), /已停止/);
  console.log('Automation cards: real native persistence + service/SDK callback path; confirmation, topic binding, fixed reuse, idempotency, authorization, changed definitions, one-time and recurring stop, expired-card replacement passed (provider mocked).');
} finally { await rm(home, { recursive: true, force: true }); }
