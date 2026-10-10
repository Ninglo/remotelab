import test from 'node:test';
import assert from 'node:assert/strict';
import { processMonitoringRecovery, projectRecovery } from '../chat/monitoring-recovery.mjs';

function fixture({ conversation = false, kind = 'automation' } = {}) {
  let state = null, admissions = 0, lostAck = false;
  const receipts = new Map(), requests = new Map();
  const session = { id: 'session', tool: 'codex', model: 'auto', effort: '', thinking: false,
    activity: { run: { state: 'idle' }, queue: { count: 0 } },
    ...(conversation ? { conversation: { connector: 'feishu', sourceRouteId: 'bot', target: { chatId: 'oc_original' } } } : {}) };
  const origin = { id: 'run_origin', state: 'failed', model: 'gpt-6.1-sol', createdAt: '2026-10-05T00:00:00Z' };
  const runs = new Map([[origin.id, origin]]);
  const task = { id: 'sch_original', state: 'active', prompt: 'Publish the original daily, preserve comments.',
    lastExecution: { state: 'failed', runId: origin.id, sessionId: session.id, completedAt: '2026-10-05T00:01:00Z', error: 'Selected model is at capacity.' },
    resultDelivery: { mode: conversation ? 'conversation' : 'remotelab' } };
  const snapshot = { generatedAt: '2026-10-05T00:02:00Z', disks: [], services: [], coverage: { gaps: [] },
    automations: { items: kind === 'automation' ? [task] : [] },
    attention: [{ kind, id: kind === 'automation' ? task.id : '/', subject: 'Original', severity: 'critical' }] };
  let latestRunId = origin.id, deliveries = [];
  const options = { config: { enabled: true, coordinatorSessionId: session.id, maxAttempts: 2, maxConcurrent: 1 }, snapshot,
    now: Date.parse(snapshot.generatedAt), stateFile: 'ledger',
    load: async path => structuredClone(path === 'ledger' ? state : receipts.get(path) || null),
    save: async (_path, value) => { state = structuredClone(value); },
    readDeliveries: async () => structuredClone(deliveries),
    request: async (path, options = {}) => {
      const method = options.method || 'GET';
      if (path === '/api/sessions/session/latest-run') return { runId: latestRunId };
      if (path.startsWith('/api/sessions/session/responses/')) {
        const run = requests.get(decodeURIComponent(path.split('/').at(-1)));
        if (!run) throw Object.assign(new Error('not found'), { code: 'HTTP_404' });
        return { replyPublication: { rootRunId: run.id } };
      }
      if (path === '/api/automation-tasks/sch_original') return { task };
      if (path.startsWith('/api/source-deliveries')) return { deliveries };
      if (path === '/api/sessions/session' && method === 'GET') return { session: structuredClone(session) };
      if (path === '/api/sessions/session' && method === 'PATCH') { Object.assign(session, options.body); return { session }; }
      if (path === '/api/sessions/session/messages') {
        const prior = requests.get(options.body.requestId);
        if (prior) return { run: prior, duplicate: true };
        const run = { id: `run_repair_${++admissions}`, state: 'running', model: session.model, effort: session.effort,
          createdAt: '2026-10-05T00:02:00Z', requestId: options.body.requestId };
        requests.set(options.body.requestId, run); runs.set(run.id, run); latestRunId = run.id;
        if (lostAck) { lostAck = false; throw Object.assign(new Error('ack lost'), { code: 'ECONNRESET' }); }
        return { run };
      }
      if (path.startsWith('/api/runs/')) return { run: runs.get(path.split('/')[3]) };
      throw new Error(`Unexpected API ${method} ${path}`);
    } };
  const incident = () => Object.values(state.incidents)[0];
  return { options, task, runs, session, snapshot, incident, receipts, getState: () => state, getAdmissions: () => admissions,
    setLatest: id => { latestRunId = id; }, loseAck: () => { lostAck = true; },
    delivery: list => { deliveries = list; },
    finish: (status = 'resolved') => {
      const item = incident(), attempt = item.attempts.at(-1);
      runs.get(attempt.runId).state = 'completed';
      receipts.set(attempt.receiptFile, { key: item.key, requestId: attempt.requestId, status,
        summary: 'Verified real output', evidence: ['publication-receipt.json'],
        checks: { task: true, delivery: 'not_required' }, requiredHumanAction: 'Supply missing resource access' });
    } };
}

test('one durable incident resumes the original Session with the actual fallback, without repeated admissions', async () => {
  const f = fixture();
  const result = await processMonitoringRecovery(f.options);
  assert.equal(result.admitted, 1); assert.equal(f.session.model, 'gpt-6-sol');
  assert.equal(f.incident().status, 'running');
  await processMonitoringRecovery(f.options); assert.equal(f.getAdmissions(), 1);
  f.finish(); await processMonitoringRecovery(f.options);
  assert.equal(f.incident().status, 'resolved'); assert.equal(f.session.model, 'auto', 'restore the saved Session preference after the attempt');
  await processMonitoringRecovery(f.options); assert.equal(f.getAdmissions(), 1, 'the unchanged original failure must not create another repair');
});

test('service recovery waits for three distinct failed observations, with durable counts', async () => {
  const f = fixture({ kind: 'service' }); f.options.config.serviceConfirmationObservations = 3;
  let apiCalls = 0; const request = f.options.request;
  f.options.request = async (...args) => { apiCalls++; return request(...args); };
  await processMonitoringRecovery(f.options);
  await processMonitoringRecovery(f.options);
  assert.equal(apiCalls, 0, 're-reading the same snapshot cannot confirm a second failure or query admission');
  assert.equal(f.getState().resources['service:/'].observations, 1);
  for (let round = 1; round <= 2; round++) {
    f.snapshot.generatedAt = new Date(f.options.now + round * 60_000).toISOString();
    await processMonitoringRecovery({ ...f.options, now: f.options.now + round * 60_000 });
    assert.equal(f.getAdmissions(), round === 2 ? 1 : 0);
  }
  assert.equal(f.incident().status, 'running');
});

test('a brief restart resets service confirmation after independent recovery', async () => {
  const f = fixture({ kind: 'service' }); f.options.config.serviceConfirmationObservations = 3;
  await processMonitoringRecovery(f.options);
  const failure = f.snapshot.attention[0];
  f.snapshot.attention = []; f.snapshot.services = [{ unit: '/', status: 'healthy' }];
  f.snapshot.generatedAt = new Date(f.options.now + 60_000).toISOString();
  await processMonitoringRecovery({ ...f.options, now: f.options.now + 60_000 });
  assert.equal(f.incident().status, 'resolved'); assert.equal(f.getAdmissions(), 0);
  f.snapshot.attention = [failure]; f.snapshot.services = [{ unit: '/', status: 'critical' }];
  f.snapshot.generatedAt = new Date(f.options.now + 120_000).toISOString();
  await processMonitoringRecovery({ ...f.options, now: f.options.now + 120_000 });
  assert.equal(f.getState().resources['service:/'].observations, 1); assert.equal(f.getAdmissions(), 0);
});

test('unknown service readings cannot admit a delayed repair, while disk emergencies stay immediate', async () => {
  const f = fixture({ kind: 'service' }); f.options.config.serviceConfirmationObservations = 3;
  f.session.activity.run.state = 'running';
  for (let round = 0; round < 3; round++) {
    f.snapshot.generatedAt = new Date(f.options.now + round * 60_000).toISOString();
    await processMonitoringRecovery({ ...f.options, now: f.options.now + round * 60_000 });
  }
  f.session.activity.run.state = 'idle'; f.snapshot.attention = [];
  f.snapshot.services = [{ unit: '/', status: 'unknown' }];
  await processMonitoringRecovery({ ...f.options, now: f.options.now + 180_000 });
  assert.equal(f.getAdmissions(), 0);
  const g = fixture({ kind: 'disk' }); g.options.config.serviceConfirmationObservations = 3;
  await processMonitoringRecovery(g.options); assert.equal(g.getAdmissions(), 1);
});

test('lost admission acknowledgement and observer restart reuse the same request identity', async () => {
  const f = fixture(); f.loseAck();
  await processMonitoringRecovery(f.options); assert.equal(f.incident().status, 'admitting');
  await processMonitoringRecovery(f.options); assert.equal(f.getAdmissions(), 1); assert.equal(f.incident().status, 'running');
});

test('an uncertain admission occupies the global slot until readback, and does not trigger a parallel recovery wave', async () => {
  const f = fixture(); f.loseAck();
  const other = { ...f.task, id: 'sch_other', lastExecution: { ...f.task.lastExecution, runId: 'run_other', sessionId: 'other' } };
  f.snapshot.automations.items.push(other);
  f.snapshot.attention.push({ kind: 'automation', id: other.id, subject: 'Other', severity: 'critical' });
  const request = f.options.request; let queriedOther = false;
  f.options.request = async (path, options) => {
    if (path.startsWith('/api/sessions/other')) queriedOther = true;
    return request(path, options);
  };
  await processMonitoringRecovery(f.options); assert.equal(queriedOther, false); assert.equal(f.getAdmissions(), 1);
  await processMonitoringRecovery(f.options); assert.equal(queriedOther, false); assert.equal(f.getAdmissions(), 1);
});

test('a different actual Run model cancels recovery and restores the saved preference', async () => {
  const f = fixture(); const request = f.options.request; let cancelled = false;
  f.options.request = async (path, options) => {
    if (path.endsWith('/cancel')) { cancelled = true; return {}; }
    const result = await request(path, options);
    if (path.startsWith('/api/runs/run_repair_')) return { run: { ...result.run, model: 'gpt-6.1-sol' } };
    return result;
  };
  await processMonitoringRecovery(f.options);
  assert.equal(cancelled, true); assert.equal(f.incident().status, 'blocked'); assert.equal(f.session.model, 'auto');
});

test('a manual continuation in progress is adopted, not run again; after completion only verification is requested', async () => {
  const f = fixture(); f.runs.set('run_manual', { id: 'run_manual', state: 'running', createdAt: '2026-10-05T00:01:30Z' }); f.setLatest('run_manual');
  await processMonitoringRecovery(f.options); assert.equal(f.incident().status, 'waiting'); assert.equal(f.getAdmissions(), 0);
  f.runs.get('run_manual').state = 'completed'; await processMonitoringRecovery(f.options);
  assert.equal(f.incident().attempts[0].mode, 'verify'); assert.match(f.incident().attempts[0].body.text, /不能把整份任务从头再执行/);
});

test('a completed provider run cannot close a fault without actual acceptance evidence', async () => {
  const f = fixture(); await processMonitoringRecovery(f.options);
  f.runs.get(f.incident().attempts[0].runId).state = 'completed'; await processMonitoringRecovery(f.options);
  assert.equal(f.incident().attempts.length, 2); assert.equal(f.incident().attempts[1].mode, 'verify');
  f.runs.get(f.incident().attempts[1].runId).state = 'completed'; await processMonitoringRecovery(f.options);
  assert.equal(f.incident().status, 'blocked'); assert.equal(f.getAdmissions(), 2);
});

test('permission and business blockers stop with the recorded minimal human action', async () => {
  const f = fixture(); await processMonitoringRecovery(f.options); f.finish('blocked');
  await processMonitoringRecovery(f.options); assert.equal(f.incident().status, 'blocked');
  assert.match(f.incident().reason, /missing resource access/);
  await processMonitoringRecovery(f.options); assert.equal(f.getAdmissions(), 1);
});

test('delivery uncertainty is reconciled separately; opening receipts never count and no duplicate message is submitted', async () => {
  const f = fixture({ conversation: true }); await processMonitoringRecovery(f.options); f.finish();
  const runId = f.incident().attempts[0].runId;
  f.delivery([{ runId, surfaceKind: 'opening', state: 'delivered', externalId: 'om_opening' }]);
  await processMonitoringRecovery(f.options); assert.equal(f.incident().status, 'verifying'); assert.equal(f.getAdmissions(), 1);
  f.delivery([{ runId, surfaceKind: 'final', state: 'delivered', externalId: 'om_final' }]);
  await processMonitoringRecovery(f.options); assert.equal(f.incident().status, 'resolved'); assert.equal(f.getAdmissions(), 1);
});

test('archived final receipts close recovery even after the active outbox is empty', async () => {
  const f = fixture({ conversation: true }); await processMonitoringRecovery(f.options); f.finish();
  const attempt = f.incident().attempts[0];
  f.options.readDeliveries = async (sessionId, requestId) => {
    assert.equal(sessionId, f.session.id); assert.equal(requestId, attempt.requestId);
    return [{ responseId: requestId, surfaceKind: 'final', state: 'delivered', externalId: 'om_archived' }];
  };
  const request = f.options.request;
  f.options.request = async (path, options) => path.startsWith('/api/source-deliveries') ? { deliveries: [] } : request(path, options);
  await processMonitoringRecovery(f.options);
  assert.equal(f.incident().status, 'resolved'); assert.equal(f.getAdmissions(), 1);
});

test('known delivery failures and pending delivery deadlines stay blocked without sending again', async () => {
  const f = fixture({ conversation: true }); await processMonitoringRecovery(f.options); f.finish();
  await processMonitoringRecovery(f.options);
  await processMonitoringRecovery({ ...f.options, now: f.options.now + 11 * 60_000 });
  assert.equal(f.incident().status, 'blocked'); assert.equal(f.getAdmissions(), 1);
});

test('bounded alternate model attempts stop after two failures and preserve a concurrent preference change', async () => {
  const f = fixture(); await processMonitoringRecovery(f.options);
  f.runs.get(f.incident().attempts[0].runId).state = 'failed'; f.session.model = 'gpt-6-astra';
  await processMonitoringRecovery(f.options);
  assert.equal(f.incident().attempts[1].previousRuntime.model, 'gpt-6-astra');
  assert.equal(f.incident().attempts[1].model, 'gpt-5.6-sol');
  f.runs.get(f.incident().attempts[1].runId).state = 'failed'; await processMonitoringRecovery(f.options);
  assert.equal(f.incident().status, 'blocked'); assert.equal(f.session.model, 'gpt-6-astra'); assert.equal(f.getAdmissions(), 2);
});

test('paused/updated jobs, unavailable reads and dry runs never create an extra execution', async () => {
  const f = fixture(); f.task.state = 'paused'; await processMonitoringRecovery(f.options); assert.equal(f.getAdmissions(), 0);
  f.task.state = 'active'; await processMonitoringRecovery({ ...f.options, dryRun: true }); assert.equal(f.getAdmissions(), 0);
  await processMonitoringRecovery({ ...f.options, request: async () => { throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' }); } });
  assert.equal(f.getAdmissions(), 0); assert.match(f.incident().reason, /ECONNREFUSED/);
});

test('an explicit disabled flag prevents recovery even if the scheduler lifecycle still reads active', async () => {
  const f = fixture(); f.task.enabled = false;
  await processMonitoringRecovery(f.options);
  assert.equal(f.getAdmissions(), 0);
  assert.equal(Object.keys(f.getState().incidents).length, 0);
});

test('a task disabled after the snapshot is rechecked before any new recovery admission', async () => {
  const f = fixture();
  f.snapshot.automations.items = [structuredClone(f.task)];
  f.task.enabled = false;
  await processMonitoringRecovery(f.options);
  assert.equal(f.getAdmissions(), 0);
  assert.equal(f.incident().status, 'cancelled');
  assert.equal(f.session.model, 'auto');
});

test('resource repair is not verified by an AI claim while the independent measurement is still critical', async () => {
  const f = fixture({ kind: 'disk' }); await processMonitoringRecovery(f.options); f.finish();
  await processMonitoringRecovery(f.options); assert.equal(f.incident().status, 'blocked');
  const g = fixture({ kind: 'disk' }); await processMonitoringRecovery(g.options); g.finish();
  g.snapshot.disks = [{ path: '/', status: 'healthy' }]; g.snapshot.attention = [];
  await processMonitoringRecovery(g.options); assert.equal(g.incident().status, 'resolved');
});

test('resource work waits for a busy coordinator and recovery projection exposes no admission prompt or private failure details', async () => {
  const f = fixture({ kind: 'disk' }); f.runs.set('run_busy', { id: 'run_busy', state: 'running' }); f.setLatest('run_busy');
  await processMonitoringRecovery(f.options); assert.equal(f.getAdmissions(), 0); assert.equal(f.incident().status, 'pending');
  assert.doesNotMatch(JSON.stringify(projectRecovery(f.getState())), /original daily|sourceDelivery|receiptFile|Selected model/);
});
