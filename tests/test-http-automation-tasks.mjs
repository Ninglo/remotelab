#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import http from 'http';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const primaryCookie = 'session_token=task-center-primary';
const secondPersonCookie = 'session_token=task-center-second';

function randomPort() {
  return 36000 + Math.floor(Math.random() * 8000);
}

async function waitFor(predicate, description, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let delayMs = 25;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    delayMs = Math.min(200, delayMs * 2);
  }
  throw new Error(`Timed out: ${description}`);
}

function request(port, method, path, body = null, cookie = primaryCookie) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        Cookie: cookie,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function setupHome() {
  const home = mkdtempSync(join(tmpdir(), 'remotelab-task-center-'));
  const configDir = join(home, '.config', 'remotelab');
  const binDir = join(home, '.local', 'bin');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(configDir, 'auth.json'), JSON.stringify({
    version: 2,
    serviceToken: 'f'.repeat(64),
    primaryPersonId: 'person_primary',
    people: [
      {
        id: 'person_primary', name: 'Primary',
        credentials: [{ id: 'credential_primary', type: 'token', token: '0'.repeat(64) }],
        identities: [{ id: 'identity_web_primary', kind: 'web', realm: 'remotelab', subjectId: 'person_primary', displayName: 'Primary' }],
      },
      {
        id: 'person_second', name: 'Second',
        credentials: [{ id: 'credential_second', type: 'token', token: '1'.repeat(64) }],
        identities: [{ id: 'identity_web_second', kind: 'web', realm: 'remotelab', subjectId: 'person_second', displayName: 'Second' }],
      },
    ],
  }));
  writeFileSync(join(configDir, 'auth-sessions.json'), JSON.stringify({
    'task-center-primary': { expiry: Date.now() + 3600000, personId: 'person_primary', personName: 'Primary', identityId: 'identity_web_primary' },
    'task-center-second': { expiry: Date.now() + 3600000, personId: 'person_second', personName: 'Second', identityId: 'identity_web_second' },
  }));
  writeFileSync(join(configDir, 'tools.json'), JSON.stringify([{
    id: 'task-center-tool',
    name: 'Task Center Tool',
    command: 'task-center-tool',
    runtimeFamily: 'codex-json',
    models: [{ id: 'fixture-model', label: 'Fixture model', defaultEffort: 'low' }],
    reasoning: { kind: 'enum', label: 'Reasoning', levels: ['low'], default: 'low' },
  }]));
  writeFileSync(join(binDir, 'task-center-tool'), `#!/usr/bin/env node
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'task-center-thread' }));
console.log(JSON.stringify({ type: 'turn.started' }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'task center run complete' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
`);
  chmodSync(join(binDir, 'task-center-tool'), 0o755);
  return { home, configDir, binDir };
}

async function startServer({ home, configDir, binDir, port }) {
  const child = spawn(process.execPath, ['chat-server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${binDir}:${process.env.PATH || ''}`,
      CHAT_PORT: String(port),
      CHAT_BIND_HOST: '127.0.0.1',
      SECURE_COOKIES: '0',
      REMOTELAB_CONFIG_DIR: configDir,
      REMOTELAB_MEMORY_DIR: join(home, '.remotelab', 'memory'),
      REMOTELAB_TRIGGER_POLL_MS: '25',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`Server exited during startup:\n${output}`);
    try {
      return (await request(port, 'GET', '/api/auth/me')).status === 200;
    } catch {
      return false;
    }
  }, 'Task Center test server startup');
  return { child, output: () => output };
}

async function createSession(port, name) {
  const response = await request(port, 'POST', '/api/sessions', {
    folder: repoRoot,
    tool: 'task-center-tool',
    name,
    group: 'Task Center tests',
  });
  assert.equal(response.status, 201, response.text);
  return response.json.session;
}

async function main() {
  const fixture = setupHome();
  const port = randomPort();
  const server = await startServer({ ...fixture, port });
  try {
    const secondPerson = await request(port, 'GET', '/api/automation-tasks', null, secondPersonCookie);
    assert.equal(secondPerson.status, 200, 'Task Center must be available to every authenticated Person');

    const fixedSession = await createSession(port, 'Fixed automation home');
    const templateSession = await createSession(port, 'Independent execution template');
    const bind = await request(port, 'PATCH', `/api/sessions/${fixedSession.id}`, {
      conversation: {
        connector: 'feishu',
        sourceRouteId: 'task-center-test',
        target: { chatId: 'oc_task_center' },
      },
    });
    assert.equal(bind.status, 200, bind.text);

    const fixedCreate = await request(port, 'POST', '/api/automation-tasks', {
      kind: 'one_time',
      title: 'Wake fixed Session',
      prompt: 'Inspect the latest state and continue the task.',
      scheduledAt: new Date(Date.now() + 120).toISOString(),
      target: { mode: 'fixed_session', sessionId: fixedSession.id },
      notification: { mode: 'remotelab' },
    });
    assert.equal(fixedCreate.status, 201, fixedCreate.text);
    assert.equal(fixedCreate.json.task.target.mode, 'fixed_session');
    assert.equal(fixedCreate.json.task.target.sessionId, fixedSession.id);
    assert.equal(fixedCreate.json.task.notification.mode, 'remotelab');

    const completedFixed = await waitFor(async () => {
      const response = await request(port, 'GET', `/api/automation-tasks/${fixedCreate.json.task.id}`);
      return response.json?.task?.state === 'completed' ? response.json.task : false;
    }, 'fixed Session task completion');
    assert.equal(completedFixed.lastExecution.sessionId, fixedSession.id, 'fixed mode must wake the selected Session');
    const deliveries = await request(port, 'GET', '/api/source-deliveries');
    assert.equal(deliveries.status, 200);
    assert.equal(deliveries.json.deliveries.length, 0, 'RemoteLab-only delivery must not inherit the fixed Session conversation');

    const independentCreate = await request(port, 'POST', '/api/automation-tasks', {
      kind: 'one_time',
      title: 'Independent occurrence',
      prompt: 'Run this in a new Session.',
      scheduledAt: new Date(Date.now() + 120).toISOString(),
      target: { mode: 'new_session', sessionId: templateSession.id },
      notification: { mode: 'remotelab' },
    }, secondPersonCookie);
    assert.equal(independentCreate.status, 201, independentCreate.text);
    assert.equal(independentCreate.json.task.createdByIdentityId, 'identity_web_second');
    const completedIndependent = await waitFor(async () => {
      const response = await request(port, 'GET', `/api/automation-tasks/${independentCreate.json.task.id}`);
      return response.json?.task?.state === 'completed' ? response.json.task : false;
    }, 'independent Session task completion');
    assert.notEqual(
      completedIndependent.lastExecution.sessionId,
      templateSession.id,
      'new_session mode must create an independent execution Session',
    );
    const independentSession = await request(port, 'GET', `/api/sessions/${completedIndependent.lastExecution.sessionId}`);
    assert.equal(independentSession.status, 200, independentSession.text);
    assert.equal(independentSession.json.session.initiatedByIdentityId, 'identity_web_second');

    const controllable = await request(port, 'POST', '/api/automation-tasks', {
      kind: 'one_time',
      title: 'Controllable one-time task',
      prompt: 'Run later.',
      scheduledAt: new Date(Date.now() + 60000).toISOString(),
      target: { mode: 'new_session', sessionId: templateSession.id },
      notification: { mode: 'remotelab' },
    });
    assert.equal(controllable.status, 201, controllable.text);
    const oneTimeId = controllable.json.task.id;
    assert.equal(controllable.json.task.runtime.runtimePolicy, 'follow_default');
    const pinnedRuntime = await request(port, 'PATCH', `/api/automation-tasks/${oneTimeId}`, { runtimePolicy: 'fixed' });
    assert.equal(pinnedRuntime.status, 200, pinnedRuntime.text);
    assert.equal(pinnedRuntime.json.task.runtime.runtimePolicy, 'fixed');
    assert.ok(pinnedRuntime.json.task.runtime.model);
    const followRuntime = await request(port, 'PATCH', `/api/automation-tasks/${oneTimeId}`, { runtimePolicy: 'follow_default' });
    assert.equal(followRuntime.status, 200, followRuntime.text);
    assert.equal(followRuntime.json.task.runtime.model, '');
    const invalidRuntime = await request(port, 'PATCH', `/api/automation-tasks/${oneTimeId}`, { runtimePolicy: 'bad' });
    assert.equal(invalidRuntime.status, 400);
    assert.deepEqual(controllable.json.task.actions, ['pause', 'cancel']);

    const paused = await request(port, 'POST', `/api/automation-tasks/${oneTimeId}/pause`);
    assert.equal(paused.status, 200, paused.text);
    assert.equal(paused.json.task.state, 'paused');
    assert.deepEqual(paused.json.task.actions, ['resume', 'cancel']);
    const resumed = await request(port, 'POST', `/api/automation-tasks/${oneTimeId}/resume`);
    assert.equal(resumed.status, 200, resumed.text);
    assert.equal(resumed.json.task.state, 'scheduled');
    const cancelled = await request(port, 'POST', `/api/automation-tasks/${oneTimeId}/cancel`);
    assert.equal(cancelled.status, 200, cancelled.text);
    assert.equal(cancelled.json.task.state, 'cancelled');
    const refusedResume = await request(port, 'POST', `/api/automation-tasks/${oneTimeId}/resume`);
    assert.equal(refusedResume.status, 409, 'cancel is terminal in Task Center');

    const recurring = await request(port, 'POST', '/api/automation-tasks', {
      kind: 'recurring',
      title: 'Weekday review',
      prompt: 'Review the project and choose the next action.',
      cron: '0 9 * * 1-5',
      timezone: 'Asia/Shanghai',
      target: { mode: 'new_session', sessionId: templateSession.id },
      notification: { mode: 'remotelab' },
    });
    assert.equal(recurring.status, 201, recurring.text);
    const scheduleId = recurring.json.task.id;
    assert.equal(recurring.json.task.kind, 'recurring');
    assert.equal(recurring.json.task.state, 'active');
    assert.ok(recurring.json.task.nextRunAt);
    assert.equal(recurring.json.task.target.mode, 'new_session');
    assert.equal(recurring.json.task.schedule.type, 'cron');
    assert.deepEqual(recurring.json.task.lifetime, { mode: 'continuous' });
    assert.deepEqual(recurring.json.task.gate, { mode: 'direct' });

    const pausedSchedule = await request(port, 'POST', `/api/automation-tasks/${scheduleId}/pause`);
    assert.equal(pausedSchedule.status, 200, pausedSchedule.text);
    assert.equal(pausedSchedule.json.task.state, 'paused');
    assert.equal(pausedSchedule.json.task.nextRunAt, '');
    const resumedSchedule = await request(port, 'POST', `/api/automation-tasks/${scheduleId}/resume`);
    assert.equal(resumedSchedule.status, 200, resumedSchedule.text);
    assert.equal(resumedSchedule.json.task.state, 'active');
    assert.ok(resumedSchedule.json.task.nextRunAt);
    const cancelledSchedule = await request(port, 'POST', `/api/automation-tasks/${scheduleId}/cancel`);
    assert.equal(cancelledSchedule.status, 200, cancelledSchedule.text);
    assert.equal(cancelledSchedule.json.task.state, 'cancelled');

    const gated = await request(port, 'POST', '/api/automation-tasks', {
      kind: 'recurring',
      title: 'High-frequency gated monitor',
      prompt: 'Inspect the condition that matched.',
      schedule: { type: 'interval', everySeconds: 10 },
      lifetime: { mode: 'bounded', maxExecutions: 2 },
      gate: {
        mode: 'script', runtime: 'bash', source: 'echo no', timeoutSeconds: 2, cooldownSeconds: 30,
      },
      target: { mode: 'fixed_session', sessionId: fixedSession.id },
      resultDelivery: { mode: 'source_conversation' },
      alerts: { mode: 'remotelab', on: ['gate_error', 'execution_failure'] },
    });
    assert.equal(gated.status, 201, gated.text);
    assert.equal(gated.json.task.schedule.type, 'interval');
    assert.equal(gated.json.task.schedule.everySeconds, 10);
    assert.equal(gated.json.task.lifetime.maxExecutions, 2);
    assert.equal(gated.json.task.gate.mode, 'script');
    assert.equal(gated.json.task.gate.runtime, 'bash');
    assert.equal(gated.json.task.gate.snapshotSha256.length, 64);
    assert.equal(Object.hasOwn(gated.json.task.gate, 'source'), false, 'read model must not expose gate source');
    assert.equal(gated.json.task.resultDelivery.mode, 'conversation');
    assert.equal(gated.json.task.resultDelivery.sourceRouteId, 'task-center-test');
    assert.equal(gated.json.task.alerts.mode, 'remotelab');
    const cancelledGated = await request(port, 'POST', `/api/automation-tasks/${gated.json.task.id}/cancel`);
    assert.equal(cancelledGated.status, 200, cancelledGated.text);

    const invalidGate = await request(port, 'POST', '/api/automation-tasks', {
      kind: 'recurring',
      prompt: 'Invalid gate',
      schedule: { type: 'interval', everySeconds: 10 },
      gate: { mode: 'script', runtime: 'bash' },
      target: { mode: 'new_session', sessionId: templateSession.id },
    });
    assert.equal(invalidGate.status, 400);

    const all = await request(port, 'GET', '/api/automation-tasks');
    assert.equal(all.status, 200, all.text);
    assert.equal(all.json.tasks.length, 5, 'Task Center should unify one-time triggers and recurring schedules');
    assert.ok(all.json.tasks.some((task) => task.id === fixedCreate.json.task.id && task.lastExecution?.runId));

    const invalid = await request(port, 'POST', '/api/automation-tasks', {
      kind: 'one_time',
      prompt: 'Invalid target',
      scheduledAt: new Date(Date.now() + 60000).toISOString(),
      target: { mode: 'unknown', sessionId: fixedSession.id },
    });
    assert.equal(invalid.status, 400);

    console.log('Task Center HTTP and lifecycle tests passed.');
  } finally {
    if (server.child.exitCode === null) {
      server.child.kill('SIGTERM');
      await waitFor(() => server.child.exitCode !== null, 'Task Center test server shutdown');
    }
    rmSync(fixture.home, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
