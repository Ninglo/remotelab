#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const cookie = 'session_token=test-session';

function randomPort() {
  return 34000 + Math.floor(Math.random() * 10000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 10000, intervalMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out: ${description}`);
}

function request(port, method, path, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          Cookie: cookie,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch {}
          resolve({ status: res.statusCode, headers: res.headers, json, text: data });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function setupTempHome() {
  const home = mkdtempSync(join(tmpdir(), 'remotelab-http-triggers-'));
  const configDir = join(home, '.config', 'remotelab');
  const localBin = join(home, '.local', 'bin');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(localBin, { recursive: true });

  writeFileSync(
    join(configDir, 'auth.json'),
    JSON.stringify({ token: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(configDir, 'auth-sessions.json'),
    JSON.stringify({
      'test-session': { expiry: Date.now() + 60 * 60 * 1000, role: 'owner' },
    }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(configDir, 'tools.json'),
    JSON.stringify([
      {
        id: 'fake-codex',
        name: 'Fake Codex',
        command: 'fake-codex',
        runtimeFamily: 'codex-json',
        models: [{ id: 'fake-model', label: 'Fake model', defaultEffort: 'low' }],
        reasoning: { kind: 'enum', label: 'Reasoning', levels: ['low'], default: 'low' },
      },
    ], null, 2),
    'utf8',
  );
  writeFileSync(
    join(localBin, 'fake-codex'),
    `#!/usr/bin/env node
const delay = Number(process.env.FAKE_CODEX_DELAY_MS || '300');
const prompt = process.argv.join(' ');
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-trigger-test' }));
console.log(JSON.stringify({ type: 'turn.started' }));
setTimeout(() => {
  if (prompt.includes('FAIL_TRIGGER')) {
    console.error('synthetic trigger failure');
    process.exit(2);
  }
  if (!prompt.includes('EMPTY_TRIGGER')) {
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'trigger run finished' }
  }));
  }
  console.log(JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 1, output_tokens: 1 }
  }));
}, delay);
`,
    'utf8',
  );
  chmodSync(join(localBin, 'fake-codex'), 0o755);
  return { home };
}

async function startServer({ home, port }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      CHAT_PORT: String(port),
      CHAT_BIND_HOST: '127.0.0.1',
      SECURE_COOKIES: '0',
      FAKE_CODEX_DELAY_MS: '300',
      REMOTELAB_TRIGGER_POLL_MS: '50',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  await waitFor(async () => {
    try {
      const res = await request(port, 'GET', '/api/auth/me');
      return res.status === 200;
    } catch {
      return false;
    }
  }, 'server startup');

  return {
    child,
    getStdout: () => stdout,
    getStderr: () => stderr,
  };
}

async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await waitFor(() => server.child.exitCode !== null, 'server shutdown');
}

async function createSession(port, {
  name = 'Trigger Test',
  group = 'Tests',
  description = 'Trigger delivery session',
  sourceContext = null,
} = {}) {
  const res = await request(port, 'POST', '/api/sessions', {
    folder: repoRoot,
    tool: 'fake-codex',
    name,
    group,
    description,
    ...(sourceContext ? { sourceContext } : {}),
  });
  assert.equal(res.status, 201, 'create session should succeed');
  return res.json.session;
}

async function waitForRunTerminal(port, runId) {
  return waitFor(async () => {
    const res = await request(port, 'GET', `/api/runs/${runId}`);
    if (res.status !== 200) return false;
    if (!['completed', 'failed', 'cancelled'].includes(res.json.run.state)) return false;
    return res.json.run;
  }, `run ${runId} terminal`);
}

async function getEvents(port, sessionId) {
  const res = await request(port, 'GET', `/api/sessions/${sessionId}/events`);
  assert.equal(res.status, 200, 'events request should succeed');
  return res.json.events || [];
}

async function main() {
  const { home } = setupTempHome();
  const port = randomPort();
  const server = await startServer({ home, port });

  try {
    const session = await createSession(port);

    const createTriggerRes = await request(port, 'POST', '/api/triggers', {
      sessionId: session.id,
      executionMode: 'existing_session',
      title: 'Morning check-in',
      scheduledAt: new Date(Date.now() + 200).toISOString(),
      text: 'Please give me a short morning check-in and one next step.',
      tool: 'fake-codex',
      model: 'fake-model',
      effort: 'low',
    });
    assert.equal(createTriggerRes.status, 201, 'create trigger should succeed');
    const trigger = createTriggerRes.json.trigger;
    assert.equal(trigger.status, 'pending');
    assert.equal(trigger.triggerType, 'at_time');
    assert.equal(trigger.actionType, 'session_message');
    assert.equal(trigger.executionMode, 'existing_session');

    const listRes = await request(port, 'GET', `/api/triggers?sessionId=${encodeURIComponent(session.id)}`);
    assert.equal(listRes.status, 200, 'list triggers should succeed');
    assert.equal(listRes.json.triggers.length, 1, 'session filter should find the trigger');

    const deliveredTrigger = await waitFor(async () => {
      const res = await request(port, 'GET', `/api/triggers/${trigger.id}`);
      if (res.status !== 200) return false;
      if (res.json.trigger.status !== 'delivered') return false;
      return res.json.trigger;
    }, 'trigger delivery');

    assert.equal(deliveredTrigger.enabled, false, 'delivered trigger should disable itself');
    assert.equal(deliveredTrigger.deliveryMode, 'run', 'idle target session should produce a real run');
    assert.ok(deliveredTrigger.runId, 'delivered trigger should keep the created run id');

    const run = await waitForRunTerminal(port, deliveredTrigger.runId);
    assert.equal(run.state, 'completed', 'triggered run should complete');

    await sleep(300);
    const events = await getEvents(port, session.id);
    assert.ok(
      events.some((event) => event.type === 'status' && event.content === 'scheduled trigger fired: Morning check-in'),
      'session history should record the trigger fire event',
    );
    assert.equal(
      events.filter((event) => event.type === 'message' && event.role === 'user' && event.requestId === trigger.requestId).length,
      1,
      'trigger requestId should only enter the session once',
    );

    const freshTriggerRes = await request(port, 'POST', '/api/triggers', {
      sessionId: session.id,
      title: 'Fresh run',
      scheduledAt: new Date(Date.now() + 100).toISOString(),
      text: 'Run in a fresh session.',
      tool: 'fake-codex',
      model: 'fake-model',
      effort: 'low',
    });
    assert.equal(freshTriggerRes.status, 201, 'trigger creation should default to an isolated session');
    assert.equal(freshTriggerRes.json.trigger.executionMode, 'fresh_session');
    assert.equal(freshTriggerRes.json.trigger.sourceSessionId, session.id);
    assert.equal(freshTriggerRes.json.trigger.sessionTemplate.folder, session.folder);
    assert.equal(freshTriggerRes.json.trigger.sessionTemplate.tool, 'fake-codex');
    assert.equal(freshTriggerRes.json.trigger.sessionTemplate.internalRole, 'scheduled_execution');
    const sourceFilteredTriggers = await request(
      port,
      'GET',
      `/api/triggers?sessionId=${encodeURIComponent(session.id)}`,
    );
    assert.equal(sourceFilteredTriggers.status, 200);
    assert.ok(
      sourceFilteredTriggers.json.triggers.some((entry) => entry.id === freshTriggerRes.json.trigger.id),
      'fresh triggers should remain discoverable from their source session',
    );
    const deliveredFresh = await waitFor(async () => {
      const res = await request(port, 'GET', `/api/triggers/${freshTriggerRes.json.trigger.id}`);
      return res.status === 200 && res.json.trigger.status === 'delivered' ? res.json.trigger : false;
    }, 'fresh trigger delivery');
    assert.ok(deliveredFresh.executionSessionId, 'fresh trigger should retain its execution session');
    assert.notEqual(deliveredFresh.executionSessionId, session.id, 'fresh trigger must not reuse an existing session');
    const originalEventsAfterFresh = await getEvents(port, session.id);
    assert.equal(
      originalEventsAfterFresh.filter((event) => event.requestId === freshTriggerRes.json.trigger.requestId).length,
      0,
      'a default one-time trigger must not append any event to its source conversation',
    );
    const freshSessionRes = await request(port, 'GET', `/api/sessions/${deliveredFresh.executionSessionId}`);
    assert.equal(freshSessionRes.status, 200);
    assert.equal(freshSessionRes.json.session.internalRole, 'scheduled_execution');
    await waitForRunTerminal(port, deliveredFresh.runId);

    const invalidTriggerMode = await request(port, 'POST', '/api/triggers', {
      sessionId: session.id,
      executionMode: 'shared_forever',
      scheduledAt: new Date(Date.now() + 60_000).toISOString(),
      text: 'Invalid mode',
    });
    assert.equal(invalidTriggerMode.status, 400, 'unknown trigger execution modes should be rejected');

    const futureTriggerRes = await request(port, 'POST', '/api/triggers', {
      sessionId: session.id,
      title: 'Later follow-up',
      scheduledAt: new Date(Date.now() + 60_000).toISOString(),
      text: 'Do a later follow-up.',
      tool: 'fake-codex',
    });
    assert.equal(futureTriggerRes.status, 201, 'second trigger should be created');
    const futureTrigger = futureTriggerRes.json.trigger;

    const cancelRes = await request(port, 'PATCH', `/api/triggers/${futureTrigger.id}`, {
      enabled: false,
      title: 'Later follow-up paused',
    });
    assert.equal(cancelRes.status, 200, 'patch trigger should succeed');
    assert.equal(cancelRes.json.trigger.status, 'cancelled', 'disabled pending trigger should become cancelled');
    assert.equal(cancelRes.json.trigger.title, 'Later follow-up paused');

    const deleteRes = await request(port, 'DELETE', `/api/triggers/${futureTrigger.id}`);
    assert.equal(deleteRes.status, 200, 'delete trigger should succeed');

    const afterDeleteRes = await request(port, 'GET', `/api/triggers/${futureTrigger.id}`);
    assert.equal(afterDeleteRes.status, 404, 'deleted trigger should not be found');

    const sourceSession = await createSession(port, {
      name: 'Feishu Source Delivery',
      sourceContext: {
        connector: 'feishu',
        sourceRouteId: 'default',
        conversationKind: 'group',
        chatType: 'group',
        chatId: 'oc_source_test',
      },
    });
    const isolatedTriggers = [];
    for (const title of ['Isolated A', 'Isolated B']) {
      const res = await request(port, 'POST', '/api/triggers', {
        sessionId: sourceSession.id,
        title,
        scheduledAt: new Date(Date.now() + 100).toISOString(),
        text: `Run ${title}`,
        tool: 'fake-codex',
        deliverTo: 'session_source',
      });
      assert.equal(res.status, 201);
      assert.equal(res.json.trigger.sourceDelivery.target.chatId, 'oc_source_test');
      isolatedTriggers.push(res.json.trigger);
    }

    const deliveredIsolated = [];
    for (const isolated of isolatedTriggers) {
      deliveredIsolated.push(await waitFor(async () => {
        const res = await request(port, 'GET', `/api/triggers/${isolated.id}`);
        return res.status === 200 && res.json.trigger.status === 'delivered'
          ? res.json.trigger
          : false;
      }, `${isolated.title} delivery`));
    }
    assert.notEqual(deliveredIsolated[0].runId, deliveredIsolated[1].runId, 'each trigger must get its own model run');
    assert.notEqual(
      deliveredIsolated[0].executionSessionId,
      deliveredIsolated[1].executionSessionId,
      'each one-time trigger must get its own execution session',
    );
    assert.ok(
      deliveredIsolated.every((entry) => entry.executionSessionId !== sourceSession.id),
      'one-time triggers must not append to the source conversation',
    );
    assert.deepEqual(deliveredIsolated.map((entry) => entry.deliveryMode), ['run', 'run']);
    await Promise.all(deliveredIsolated.map((entry) => waitForRunTerminal(port, entry.runId)));

    const deliveryClaim = await waitFor(async () => {
      const res = await request(port, 'POST', '/api/source-deliveries/claim', {
        connector: 'feishu',
        sourceRouteId: 'default',
      });
      return res.status === 200 && res.json.claim?.delivery ? res.json.claim : false;
    }, 'source delivery outbox job');
    assert.equal(deliveryClaim.delivery.target.chatId, 'oc_source_test');
    assert.equal(deliveryClaim.delivery.text, 'trigger run finished');
    assert.ok(
      isolatedTriggers.some((entry) => entry.id === deliveryClaim.delivery.triggerId),
      'source delivery must remain traceable to one trigger',
    );
    const completeDelivery = await request(
      port,
      'POST',
      `/api/source-deliveries/${deliveryClaim.delivery.id}/complete`,
      { leaseId: deliveryClaim.leaseId, externalId: 'om_source_out' },
    );
    assert.equal(completeDelivery.status, 200);
    assert.equal(completeDelivery.json.delivery.state, 'delivered');

    for (const testCase of [
      { marker: 'FAIL_TRIGGER', expectedState: 'failed', expectedText: /定时任务执行失败/ },
    ]) {
      const created = await request(port, 'POST', '/api/triggers', {
        sessionId: sourceSession.id,
        title: testCase.marker,
        scheduledAt: new Date(Date.now() + 50).toISOString(),
        text: testCase.marker,
        tool: 'fake-codex',
        deliverTo: 'session_source',
      });
      assert.equal(created.status, 201);
      const delivered = await waitFor(async () => {
        const res = await request(port, 'GET', `/api/triggers/${created.json.trigger.id}`);
        return res.status === 200 && res.json.trigger.runId ? res.json.trigger : false;
      }, `${testCase.marker} trigger run`);
      const terminal = await waitForRunTerminal(port, delivered.runId);
      assert.equal(terminal.state, testCase.expectedState);
      const outbound = await waitFor(async () => {
        const res = await request(port, 'GET', '/api/source-deliveries');
        return res.status === 200
          ? res.json.deliveries.find((entry) => entry.triggerId === created.json.trigger.id) || false
          : false;
      }, `${testCase.marker} source delivery`);
      assert.match(outbound.text, testCase.expectedText);
    }

    const emptyTrigger = await request(port, 'POST', '/api/triggers', {
      sessionId: sourceSession.id,
      title: 'EMPTY_TRIGGER',
      scheduledAt: new Date(Date.now() + 50).toISOString(),
      text: 'EMPTY_TRIGGER',
      tool: 'fake-codex',
      deliverTo: 'session_source',
    });
    assert.equal(emptyTrigger.status, 201);
    const deliveredEmpty = await waitFor(async () => {
      const res = await request(port, 'GET', `/api/triggers/${emptyTrigger.json.trigger.id}`);
      return res.status === 200 && res.json.trigger.runId ? res.json.trigger : false;
    }, 'EMPTY_TRIGGER run');
    const emptyTerminal = await waitForRunTerminal(port, deliveredEmpty.runId);
    assert.equal(emptyTerminal.state, 'completed');
    await sleep(200);
    const emptyDeliveries = await request(
      port,
      'GET',
      '/api/source-deliveries',
    );
    assert.equal(emptyDeliveries.status, 200);
    assert.equal(
      emptyDeliveries.json.deliveries.find(
        (entry) => entry.triggerId === emptyTrigger.json.trigger.id,
      ),
      undefined,
      'a completed trigger with no assistant content should remain silent',
    );

    const scheduleRes = await request(port, 'POST', '/api/schedules', {
      sessionId: sourceSession.id,
      title: 'Weekday date',
      cron: '0 9 * * 1-5',
      timezone: 'Asia/Shanghai',
      text: 'Send the date',
      tool: 'fake-codex',
      deliverTo: 'session_source',
    });
    assert.equal(scheduleRes.status, 201, 'recurring schedule should be created');
    assert.equal(scheduleRes.json.schedule.executionMode, 'fresh_session');
    assert.equal(scheduleRes.json.schedule.sessionTemplate.folder, sourceSession.folder);
    assert.equal(scheduleRes.json.schedule.sessionTemplate.tool, 'fake-codex');
    assert.equal(scheduleRes.json.schedule.sessionTemplate.internalRole, 'scheduled_execution');
    assert.equal(scheduleRes.json.schedule.sourceDelivery.target.chatId, 'oc_source_test');
    const invalidScheduleMode = await request(port, 'POST', '/api/schedules', {
      sessionId: sourceSession.id,
      executionMode: 'shared_forever',
      cron: '0 9 * * *',
      text: 'Invalid mode',
    });
    assert.equal(invalidScheduleMode.status, 400, 'unknown schedule execution modes should be rejected');
    const scheduleId = scheduleRes.json.schedule.id;
    const cancelSchedule = await request(port, 'PATCH', `/api/schedules/${scheduleId}`, {
      enabled: false,
    });
    assert.equal(cancelSchedule.status, 200);
    assert.equal(cancelSchedule.json.schedule.status, 'cancelled');
  } finally {
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }

  console.log('test-http-triggers: ok');
}

await main();
