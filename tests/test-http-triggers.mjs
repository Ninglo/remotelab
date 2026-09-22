#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
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
      {
        id: 'source-harness',
        name: 'Source Harness',
        command: 'fake-codex',
        runtimeFamily: 'codex-json',
        models: [{ id: 'source-model', label: 'Source model', defaultEffort: 'high' }],
        reasoning: { kind: 'enum', label: 'Reasoning', levels: ['high'], default: 'high' },
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
      REMOTELAB_PUBLIC_BASE_URL: 'https://fixture.example.test',
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
  tool = 'fake-codex',
  model = '',
  effort = '',
} = {}) {
  const res = await request(port, 'POST', '/api/sessions', {
    folder: repoRoot,
    tool,
    name,
    group,
    description,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
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
  let server = await startServer({ home, port });

  try {
    const defaultRuntimeRes = await request(port, 'POST', '/api/runtime-selection', {
      selectedTool: 'fake-codex',
      selectedModel: 'fake-model',
      selectedEffort: 'low',
      reasoningKind: 'enum',
    });
    assert.equal(defaultRuntimeRes.status, 200, 'Default runtime selection should be configured');
    const session = await createSession(port);

    const createTriggerRes = await request(port, 'POST', '/api/triggers', {
      sessionId: session.id,
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
    assert.equal(trigger.sourceSessionId, session.id);
    assert.equal(trigger.executionSessionId, '');
    assert.equal(trigger.sessionTemplate.folder, session.folder);
    assert.equal(trigger.sessionTemplate.tool, 'fake-codex');
    assert.equal(trigger.sessionTemplate.internalRole, 'scheduled_execution');

    const listRes = await request(port, 'GET', `/api/triggers?sessionId=${encodeURIComponent(session.id)}`);
    assert.equal(listRes.status, 200, 'list triggers should succeed');
    assert.equal(listRes.json.triggers.length, 1, 'source-session filter should find the trigger');

    const deliveredTrigger = await waitFor(async () => {
      const res = await request(port, 'GET', `/api/triggers/${trigger.id}`);
      if (res.status !== 200) return false;
      if (res.json.trigger.status !== 'delivered') return false;
      return res.json.trigger;
    }, 'trigger delivery');

    assert.equal(deliveredTrigger.enabled, false, 'delivered trigger should disable itself');
    assert.equal(deliveredTrigger.deliveryMode, 'run', 'trigger should produce a real run');
    assert.ok(deliveredTrigger.runId, 'delivered trigger should keep the created run id');
    assert.ok(deliveredTrigger.executionSessionId, 'trigger should retain its execution session');
    assert.notEqual(
      deliveredTrigger.executionSessionId,
      session.id,
      'trigger execution must never reuse the source conversation',
    );

    const run = await waitForRunTerminal(port, deliveredTrigger.runId);
    assert.equal(run.state, 'completed', 'triggered run should complete');

    await sleep(300);
    const sourceEvents = await getEvents(port, session.id);
    assert.equal(
      sourceEvents.filter((event) => event.requestId === trigger.requestId).length,
      0,
      'a trigger must not append any event to its source conversation',
    );
    const executionEvents = await getEvents(port, deliveredTrigger.executionSessionId);
    assert.ok(
      executionEvents.some((event) => event.type === 'status' && event.content === 'scheduled trigger fired: Morning check-in'),
      'the new execution session should record the trigger fire event',
    );
    assert.equal(
      executionEvents.filter((event) => event.type === 'message' && event.role === 'user' && event.requestId === trigger.requestId).length,
      1,
      'the trigger request should enter only its new execution session',
    );
    const executionSessionRes = await request(port, 'GET', `/api/sessions/${deliveredTrigger.executionSessionId}`);
    assert.equal(executionSessionRes.status, 200);
    assert.equal(executionSessionRes.json.session.internalRole, 'scheduled_execution');

    const conversation = { connector: 'feishu', sourceRouteId: 'scheduled-bot', target: { chatId: 'scheduled-chat' } };
    const scheduleInto = async binding => {
      const response = await request(port, 'POST', '/api/triggers', {
        sessionId: session.id, title: 'Conversation execution', conversation: binding,
        scheduledAt: new Date(Date.now() + 200).toISOString(), text: 'Publish the scheduled reply.', tool: 'fake-codex',
      });
      assert.equal(response.status, 201);
      assert.equal(response.json.trigger.model, 'fake-model', 'trigger should snapshot the matching Default model');
      assert.equal(response.json.trigger.effort, 'low', 'trigger should snapshot the matching Default effort');
      assert.deepEqual(response.json.trigger.sessionTemplate.conversation, binding, 'scheduled conversation belongs to the creation template');
      const executed = await waitFor(async () => {
        const value = await request(port, 'GET', `/api/triggers/${response.json.trigger.id}`);
        return value.json.trigger.status === 'delivered' ? value.json.trigger : null;
      }, 'conversation trigger admission');
      await waitForRunTerminal(port, executed.runId);
      return executed;
    };
    const firstOccurrence = await scheduleInto(conversation);
    const firstDelivery = await waitFor(async () => {
      const value = await request(port, 'POST', '/api/source-deliveries/claim', { connector: 'feishu', sourceRouteId: 'scheduled-bot' });
      return value.json.claim;
    }, 'scheduled first reply');
    assert.equal(firstDelivery.delivery.kind, 'content', 'scheduled execution publishes one result without an extra opening notice');
    assert(firstDelivery.delivery.text.includes(firstOccurrence.executionSessionId), 'scheduled report includes its execution Session link');
    const published = await request(port, 'POST', `/api/source-deliveries/${firstDelivery.delivery.id}/complete`, {
      leaseId: firstDelivery.leaseId, externalId: 'scheduled-root', messageId: 'scheduled-root', threadId: 'scheduled-thread',
    });
    assert.equal(published.status, 200);
    const boundSession = (await request(port, 'GET', `/api/sessions/${firstOccurrence.executionSessionId}`)).json.session;
    assert.equal(boundSession.conversation.target.rootId, 'scheduled-root');
    const visible = (await request(port, 'GET', '/api/sessions')).json.sessions;
    assert(visible.some(item => item.id === firstOccurrence.executionSessionId), 'scheduled work is manageable in the ordinary Session list');
    const continued = await scheduleInto(boundSession.conversation);
    assert.equal(continued.executionSessionId, firstOccurrence.executionSessionId, 'targeting a bound topic continues its one Session');
    const secondOccurrence = await scheduleInto(conversation);
    assert.notEqual(secondOccurrence.executionSessionId, firstOccurrence.executionSessionId, 'next group occurrence starts an independent Session/topic');
    console.log('PASS: optional scheduled conversation, new topic, exact continuation, Session link and visibility');

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
      assert.equal(res.json.trigger.sessionTemplate.conversation.target.chatId, 'oc_source_test');
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
    assert.ok(deliveryClaim.delivery.text.startsWith('trigger run finished\n\n'));
    assert.ok(deliveryClaim.delivery.text.includes(`https://fixture.example.test/?session=${deliveryClaim.delivery.sessionId}&tab=sessions`));
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
    assert.equal(scheduleRes.json.schedule.sourceSessionId, sourceSession.id);
    assert.equal(scheduleRes.json.schedule.sessionTemplate.folder, sourceSession.folder);
    assert.equal(scheduleRes.json.schedule.sessionTemplate.tool, 'fake-codex');
    assert.equal(scheduleRes.json.schedule.sessionTemplate.internalRole, 'scheduled_execution');
    assert.equal(scheduleRes.json.schedule.sessionTemplate.conversation.target.chatId, 'oc_source_test');
    assert.equal(scheduleRes.json.schedule.tool, 'fake-codex', 'schedule should snapshot the matching Default Harness');
    assert.equal(scheduleRes.json.schedule.model, 'fake-model', 'schedule should snapshot the matching Default model');
    assert.equal(scheduleRes.json.schedule.effort, 'low', 'schedule should snapshot the matching Default effort');
    const scheduleId = scheduleRes.json.schedule.id;
    const cancelSchedule = await request(port, 'PATCH', `/api/schedules/${scheduleId}`, {
      enabled: false,
    });
    assert.equal(cancelSchedule.status, 200);
    assert.equal(cancelSchedule.json.schedule.status, 'cancelled');

    const alternateSource = await createSession(port, {
      name: 'Alternate runtime source',
      tool: 'source-harness',
      model: 'source-model',
      effort: 'high',
    });
    const defaultProfileSchedule = await request(port, 'POST', '/api/schedules', {
      sessionId: alternateSource.id,
      title: 'Atomic Default profile',
      cron: '0 10 * * *',
      timezone: 'Asia/Shanghai',
      text: 'Use the complete Default profile',
    });
    assert.equal(defaultProfileSchedule.status, 201);
    assert.deepEqual(
      {
        tool: defaultProfileSchedule.json.schedule.tool,
        model: defaultProfileSchedule.json.schedule.model,
        effort: defaultProfileSchedule.json.schedule.effort,
      },
      { tool: '', model: '', effort: '' },
      'a schedule without overrides should resolve the latest Default at execution, not snapshot it',
    );
    assert.equal(defaultProfileSchedule.json.schedule.runtimePolicy, 'follow_default');
    assert.equal(defaultProfileSchedule.json.schedule.sessionTemplate.tool, 'source-harness');

    const switchedHarnessSchedule = await request(port, 'POST', '/api/schedules', {
      sessionId: sourceSession.id,
      title: 'Explicit Harness profile',
      cron: '0 11 * * *',
      timezone: 'Asia/Shanghai',
      text: 'Resolve this Harness profile atomically',
      tool: 'source-harness',
    });
    assert.equal(switchedHarnessSchedule.status, 201);
    assert.deepEqual(
      {
        tool: switchedHarnessSchedule.json.schedule.tool,
        model: switchedHarnessSchedule.json.schedule.model,
        effort: switchedHarnessSchedule.json.schedule.effort,
      },
      { tool: 'source-harness', model: 'source-model', effort: 'high' },
      'changing Harness should resolve that Harness model and effort defaults instead of carrying the Default pair across',
    );
    // Recreate an upgrade after old admission succeeded but its trigger receipt was lost.
    await stopServer(server);
    const { createRequestStore } = await import('../chat/requests.mjs');
    const { canonicalJson } = await import('../lib/durable-records.mjs');
    const store = createRequestStore(join(home, '.config', 'remotelab', 'requests'));
    const accepted = await store.byRequest(deliveredTrigger.executionSessionId, trigger.requestId);
    await store.mutate(accepted.key, current => {
      const options = { ...current.options, queueIfBusy: false, requireIdle: true,
        sourceDelivery: { connector: 'feishu', sourceRouteId: 'legacy-bot', target: { chatId: 'legacy-group' } } };
      return { ...current, options, fingerprint: canonicalJson({ text: current.text, images: current.images, options }) };
    });
    const triggerPath = join(home, '.config', 'remotelab', 'chat-triggers.json');
    const savedTriggers = JSON.parse(readFileSync(triggerPath, 'utf8'));
    const retry = savedTriggers.find(item => item.id === trigger.id);
    Object.assign(retry, { status: 'pending', enabled: true, runId: '', deliveredAt: '', lastError: '', nextAttemptAt: '' });
    writeFileSync(triggerPath, JSON.stringify(savedTriggers));
    server = await startServer({ home, port });
    const recovered = await waitFor(async () => {
      const res = await request(port, 'GET', `/api/triggers/${trigger.id}`);
      const value = res.json.trigger;
      return value.status === 'delivered' || value.lastError ? value : false;
    }, 'old accepted trigger recovery');
    assert.equal(recovered.status, 'delivered', recovered.lastError || 'old accepted trigger should recover');
    assert.equal(recovered.runId, deliveredTrigger.runId, 'upgrade retry must not execute the task again');
    assert.equal((await getEvents(port, deliveredTrigger.executionSessionId))
      .filter(event => event.type === 'message' && event.role === 'user' && event.requestId === trigger.requestId).length, 1);

  } finally {
    await stopServer(server);
    rmSync(home, { recursive: true, force: true });
  }

  console.log('test-http-triggers: ok');
}

await main();
