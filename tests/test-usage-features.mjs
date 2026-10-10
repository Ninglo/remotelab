import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
import { Writable } from 'node:stream';
const home = await mkdtemp(join(tmpdir(), 'usage-feature-test-'));
setIsolatedTestHome(home);
const { buildUsageInsights } = await import('../chat/usage-insights.mjs');
const { normalizeUsageEvent, usageEvents, createUsageEventStore } = await import('../chat/usage-events.mjs');
const { observeHistoryUsage, observeRequestUsage } = await import('../chat/usage-event-projection.mjs');
const { commandCapability } = await import('../chat/usage-capabilities.mjs');
const { runObservedCommand } = await import('../lib/usage-command-observer.mjs');
after(async () => { await usageEvents.idle(); await rm(home, { recursive: true, force: true }); });

let sequence = 0;
const e = (timestamp, event, fields = {}) => ({ eventId: 'e-' + sequence++, timestamp, event,
  sessionId: 's', actorKind: 'agent', ...fields });
const report = events => buildUsageInsights(events, { now: 1000, start: 100,
  sessionOrigins: [{ sessionId: 's', timestamp: 20, surface: 'feishu' }] }).functions;

test('capability calls join actual Runs, deduplicate states, and exclude shell commands and automated owners', () => {
  const events = [e(101, 'message_submitted', { actorKind: 'human', personHash: 'alice', requestId: 'request', runId: 'placeholder' }),
    e(102, 'request_state', { requestId: 'request', runId: 'actual' }),
    ...Array.from({ length: 100 }, () => e(103, 'tool_started', { tool: 'bash', runId: 'actual' })),
    e(104, 'capability_state', { feature: 'search', operationId: 'one', runId: 'actual', state: 'started' }),
    e(105, 'capability_state', { feature: 'search', operationId: 'one', runId: 'actual', state: 'completed' }),
    e(106, 'capability_state', { feature: 'search', operationId: 'one', runId: 'actual', state: 'started' }),
    e(107, 'capability_state', { feature: 'search', operationId: 'two', actorKind: 'automation', personHash: 'owner', state: 'blocked' }),
    e(108, 'capability_state', { feature: 'guessed-code', operationId: 'other', state: 'completed' })];
  const x = report(events); assert.equal(x.features.length, 1);
  const row = x.features[0]; assert.equal(row.calls, 2); assert.equal(row.people, 1); assert.equal(row.completed, 1);
  assert.equal(row.blocked, 1); assert.equal(row.unfinished, 0); assert.equal(row.automated, 1); assert.equal(row.unpaired, 1);
});

test('revisits, real interventions, materials, delivery retries and knowledge retain their separate evidence boundaries', () => {
  const x = report([e(101, 'session_open', { actorKind: 'human', personHash: 'alice' }),
    e(102, 'message_submitted', { actorKind: 'human', personHash: 'alice' }),
    e(103, 'intervention', { actorKind: 'human', personHash: 'alice', operation: 'stop' }),
    e(104, 'ui_action', { actorKind: 'human', action: 'stop' }),
    e(105, 'material_submitted', { actorKind: 'human', objectId: 'file', kind: 'audio' }),
    e(106, 'material_submitted', { actorKind: 'human', objectId: 'file', kind: 'audio' }),
    e(107, 'delivery_state', { objectId: 'delivery', state: 'delivery_failed', attempts: 1 }),
    e(108, 'delivery_state', { objectId: 'delivery', state: 'delivered', attempts: 3 }),
    e(109, 'knowledge_state', { operation: 'read_memory', state: 'delivered' }),
    e(110, 'knowledge_state', { operation: 'write_memory', state: 'rejected' }),
    e(111, 'session_linked', { sessionId: 'child', parentSessionId: 's', operation: 'delegate', runId: 'child-run' }),
    e(112, 'run_state', { sessionId: 'child', runId: 'child-run', state: 'completed' }),
    e(113, 'run_state', { sessionId: 'child', runId: 'later-run', state: 'failed' })]);
  assert.deepEqual(x.revisits, { people: 1, sessions: 1, opened: 1, continued: 1, unknownOrigins: 0 });
  assert.equal(x.interventions[0].actions, 1, 'a button click is not a second applied stop');
  assert.equal(x.materials[0].files, 1); assert.equal(x.delivery.observed, 1); assert.equal(x.delivery.delivered, 1);
  assert.equal(x.delivery.failed, 0); assert.equal(x.delivery.recovered, 1); assert.equal(x.delivery.retryAttempts, 2);
  assert.deepEqual(x.knowledge, { retrieved: 1, applied: 0, rejected: 1 });
  assert.equal(x.delegation.completed, 1); assert.equal(x.delegation.failed, 0, 'a later Run is not delegated work');
});

test('automation counts accepted execution rather than checks or capability invocations, and respects gaps', () => {
  const events = [e(101, 'automation_change', { automationId: 'sch_1', operation: 'create' }),
    e(102, 'message_submitted', { actorKind: 'automation', requestId: 'one', runId: 'r1' }),
    e(103, 'run_state', { runId: 'r1', state: 'completed' }),
    e(104, 'run_state', { runId: 'unrelated', state: 'completed' })];
  assert.equal(report(events).automation.executions.observed, 1); assert.equal(report(events).automation.executions.completed, 1);
  const cut = buildUsageInsights(events, { now: 1000, gaps: [{ start: 100, end: 102.5 }] }).functions;
  assert.equal(cut.automation.executions.observed, 0, 'completion alone is not a new execution');
  assert.equal(cut.automation.changes.actions, 0);
});

test('server-only facts cannot be forged by a browser and contain no command arguments or output', () => {
  const source = { eventId: 'x', event: 'capability_state', feature: 'mail', operationId: 'op', state: 'blocked',
    arguments: ['secret'], output: 'secret', personHash: 'spoofed' };
  assert.equal(normalizeUsageEvent(source, { client: true }), null);
  const server = normalizeUsageEvent(source, { personId: 'verified' });
  assert.equal(server.operationId, 'op'); assert.ok(!JSON.stringify(server).includes('secret'));
  assert.notEqual(server.personHash, 'spoofed');
});

test('CLI entry observation preserves output, pairs states, distinguishes blockers and unverified receipts', async () => {
  const records = [], writes = [];
  const stdout = new Writable({ write(chunk, encoding, done) { writes.push(chunk.toString()); done(); } });
  const opts = { stdout, store: { record: async (event, context) => records.push({ event, context }), idle: async () => {} },
    resolveContext: async () => ({ sessionId: 's', runId: 'r', personId: 'verified', actorKind: 'agent' }) };
  const invoke = result => async io => { const raw = JSON.stringify(result); io.stdout.write(raw.slice(0, 4)); io.stdout.write(raw.slice(4)); return 0; };
  await runObservedCommand('connector', ['call', 'private:resource', '--body', 'private text'],
    invoke({ capabilityState: 'authorization_required', secret: 'private output' }), opts);
  assert.deepEqual(records.map(row => row.event.state), ['started', 'blocked']);
  assert.equal(records[0].event.operationId, records[1].event.operationId);
  assert.equal(records[0].context.personId, 'verified'); assert.ok(!JSON.stringify(records).includes('private'));
  assert.equal(writes.join(''), JSON.stringify({ capabilityState: 'authorization_required', secret: 'private output' }));
  await runObservedCommand('feishu', ['task.create'], invoke({ ok: true, confirmed: false }), opts);
  assert.equal(records.at(-1).event.state, 'unknown');
  const prior = records.length;
  await runObservedCommand('memory', ['status'], invoke({ ok: true }), opts);
  assert.equal(records.length, prior, 'help/status checks do not inflate capability use');
  assert.equal(commandCapability('publish', ['static', '--dry-run']), null);
  assert.equal(commandCapability('bash', ['echo', 'code']), null);
});

test('subproject hooks observe concrete context, routing and workboard entries only', () => {
  assert.deepEqual(commandCapability('work', ['context', '--query', 'private task']), { feature: 'project_context', operation: 'work.context' });
  assert.equal(commandCapability('work', ['route', '--file', '/private/input']).feature, 'work_routing');
  assert.equal(commandCapability('workboard', ['update', '--task', 'task']).feature, 'response_progress');
  assert.equal(commandCapability('assistant-message', ['--source', 'workboard_checklist', '--text', 'private']).feature, 'response_progress');
  assert.equal(commandCapability('assistant-message', ['--text', 'private']), null);
  assert.equal(commandCapability('work', ['review', '--file', 'file']), null);
  assert.equal(commandCapability('work', ['context', '--help']), null);
});

test('a retried old feedback receipt cannot backfill use before the named hook started', () => {
  const events = [e(120, 'capability_state', { feature: 'feedback', operationId: 'old', state: 'completed', actorKind: 'human' }),
    e(150, 'capability_state', { feature: 'feedback', operationId: 'new', state: 'completed', actorKind: 'human' })];
  const row = buildUsageInsights(events, { start: 100, now: 1000,
    featureCollectionStarts: { feedback: new Date(140).toISOString() } }).functions.features[0];
  assert.equal(row.calls, 1); assert.equal(row.directHuman, 1); assert.equal(row.latestAt, new Date(150).toISOString());
});

test('failed telemetry does not prevent a CLI action or change its error', async () => {
  let invoked = false;
  const opts = { store: { record: async () => { throw new Error('disk full'); }, idle: async () => {} },
    resolveContext: async () => { throw new Error('missing context'); } };
  assert.equal(await runObservedCommand('memory', ['context'], async () => { invoked = true; return 0; }, opts), 0);
  assert.equal(invoked, true);
  const error = new Error('real action error');
  await assert.rejects(runObservedCommand('memory', ['apply'], async () => { throw error; }, opts), caught => caught === error);
});

test('actual history and accepted Request projections emit linked, privacy-safe semantic facts', async () => {
  const sessionId = 'projection-fixture', timestamp = Date.now();
  observeHistoryUsage(sessionId, { seq: 1, type: 'tool_use', toolName: 'web_search', toolCallId: 'call', runId: 'run', timestamp,
    toolInput: { query: 'private research' } });
  observeHistoryUsage(sessionId, { seq: 2, type: 'tool_result', toolName: 'web_search', toolCallId: 'call', runId: 'run', timestamp,
    output: 'private result' });
  observeHistoryUsage(sessionId, { seq: 3, type: 'context_operation', operation: 'read_memory', phase: 'delivered', runId: 'run', timestamp,
    content: 'private profile' });
  const request = { key: 'projection-request', sessionId, requestId: 'input', runId: 'run', acceptedAt: new Date(timestamp).toISOString(),
    options: { usageActorKind: 'human', usageSurface: 'web', usagePersonId: 'verified' },
    images: [{ savedPath: '/private/material.pdf', mimeType: 'application/pdf', originalName: 'private file' }] };
  observeRequestUsage(request, { accepted: true });
  observeRequestUsage(request, { accepted: true });
  observeRequestUsage({ ...request, nativeDispatchRunId: 'actual' }, { previous: {} });
  const result = await usageEvents.query({ sessionId });
  const row = result.report.functions.features.find(row => row.feature === 'search');
  assert.equal(row.calls, 1); assert.equal(row.unknown, 1, 'no exit status is not fabricated as success');
  assert.equal(result.report.functions.materials[0].files, 1); assert.equal(result.report.functions.knowledge.retrieved, 1);
  assert.equal(result.report.functions.interventions[0].operation, 'follow_up');
  assert.ok(!JSON.stringify(result).includes('private'));
});

test('explicit Feishu idempotency keys join retry attempts without collapsing independent calls', async () => {
  const records = [];
  const opts = { store: { record: async event => records.push({ ...event, timestamp: Date.now() }), idle: async () => {} },
    resolveContext: async () => ({ sessionId: 's' }) };
  const invoke = async () => 0;
  await runObservedCommand('feishu', ['task.create', '--key', 'same'], invoke, opts);
  await runObservedCommand('feishu', ['task.create', '--key', 'same'], invoke, opts);
  await runObservedCommand('feishu', ['task.create', '--key', 'different'], invoke, opts);
  const x = buildUsageInsights(records, { now: Date.now() + 1 }).functions.features[0];
  assert.equal(x.calls, 2); assert.equal(x.retryAttempts, 1); assert.equal(x.completed, 2);
});

test('a parent filter retains the original child Run result and deliberate child opening, excluding unrelated child work', async () => {
  const sessionId = 'parent-filter', child = 'child-filter', runId = 'delegated-filter';
  await usageEvents.record([
    { eventId: 'parent-link', event: 'session_linked', sessionId: child, parentSessionId: sessionId, operation: 'delegate', runId },
    { eventId: 'child-result', event: 'run_state', sessionId: child, runId, state: 'completed' },
    { eventId: 'child-later-result', event: 'run_state', sessionId: child, runId: 'unrelated-run', state: 'failed' },
    { eventId: 'child-input', event: 'message_submitted', sessionId: child, actorKind: 'human' },
  ]);
  await usageEvents.record({ eventId: 'child-open', event: 'session_open', sessionId: child }, { client: true, personId: 'verified' });
  const x = await usageEvents.query({ sessionId });
  assert.equal(x.report.functions.delegation.completed, 1); assert.equal(x.report.functions.delegation.opened, 1);
  assert.equal(x.report.functions.delegation.failed, 0); assert.equal(x.report.activity.inputs, 0);
  assert.equal(x.events.length, 3);
});

test('fixture exclusions match exact retained records, and do not hide real records with the same event ID', async () => {
  const directory = join(home, 'fixture-exclusion');
  const store = createUsageEventStore({ directory });
  await store.record({ eventId: 'retained', event: 'message_submitted', sessionId: 'test', actorKind: 'human' });
  const file = (await readdir(directory)).find(name => name.endsWith('.jsonl'));
  const line = (await readFile(join(directory, file), 'utf8')).trim();
  const metadata = JSON.parse(await readFile(join(directory, 'collection.json'), 'utf8'));
  await writeFile(join(directory, 'collection.json'), JSON.stringify({ ...metadata, excludedFixtures: [{
    sha256: createHash('sha256').update(line).digest('hex'), reason: 'confirmed_test_fixture',
  }] }));
  const real = { ...JSON.parse(line), sessionId: 'real' };
  await writeFile(join(directory, file), line + '\n' + JSON.stringify(real) + '\n');
  const x = await store.query();
  assert.equal(x.coverage.excludedFixtureLines, 1); assert.equal(x.report.activity.sessions, 1);
  assert.equal(x.events[0].sessionId, 'real');
  assert.ok((await readFile(join(directory, file), 'utf8')).includes(line), 'original evidence is retained');
});
