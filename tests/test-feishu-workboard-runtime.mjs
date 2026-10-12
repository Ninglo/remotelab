import assert from 'node:assert/strict';
import test from 'node:test';
import { upgradeFeishuWorkboardState } from '../connectors/feishu/workboard-runtime.mjs';

test('route-wide state migration preserves private/group receipts, fences and uncertain creates', () => {
  const previous = { sourceRouteId: 'bot-2', senderOpenId: 'old-sender', sessionId: 'private', chatId: 'p2p',
    startedAfterSeq: 30, protocolAfterSeq: 40, cards: [{ anchorSeq: 50, messageId: 'old-card', latestSeq: 55 }],
    groupSessions: { group: { chatId: 'group-chat', cards: [{ anchorSeq: 10, pendingCreate: true }], protocolAfterSeq: 5 } } };
  const state = upgradeFeishuWorkboardState(previous, { sourceRouteId: 'bot-2', botConfigPath: '/private/config.json' });
  assert.equal(state.scope, 'instance');
  assert.deepEqual(state.sessions.group, previous.groupSessions.group);
  assert.deepEqual(state.sessions.private.cards, previous.cards);
  assert.equal(state.sessions.private.startedAfterSeq, 30);
  assert.equal(state.legacySenderOpenId, 'old-sender');
  assert.equal(state.expiresAt, undefined);
  assert.deepEqual(upgradeFeishuWorkboardState(state, { sourceRouteId: 'bot-2', botConfigPath: '/private/config.json' }), state);
  assert.throws(() => upgradeFeishuWorkboardState(previous, { sourceRouteId: 'other', botConfigPath: '/config' }), /route cannot change/);
  assert.deepEqual(upgradeFeishuWorkboardState({}, { sourceRouteId: 'default', botConfigPath: '/config' }).sessions, {});
  assert.notEqual(state.sessions.group.cards, previous.groupSessions.group.cards);
});

const { mkdtemp, readFile, writeFile, mkdir, rm } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { startFeishuWorkboards, describeFeishuWorkboards } = await import('../connectors/feishu/workboard-component.mjs');

test('connector owns cards, reuses client and receipts, and reports isolated startup failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'embedded-cards-'));
  try {
    await mkdir(join(root, 'workboards'));
    const statePath = join(root, 'workboards/feishu-default.json');
    const original = { scope: 'instance', sourceRouteId: 'default', protocolVersion: 2,
      sessions: { s: { chatId: 'chat', protocolAfterSeq: 17,
        cards: [{ messageId: 'original', taskId: 'task', latestSeq: 31 }, { pendingCreate: true, anchorSeq: 42 }] } } };
    await writeFile(statePath, JSON.stringify(original));
    const runtime = { config: { sourceRouteId: 'default', storageDir: root }, appClient: {} };
    const remote = {};
    let stopped = false;
    runtime.workboards = await startFeishuWorkboards(runtime, { configDir: root, configPath: '/config', remote,
      createSync: async input => {
        assert.equal(input.app, runtime.appClient);
        assert.equal(input.remote, remote);
        assert.deepEqual(input.pilot.sessions, original.sessions);
        await input.onStatus({ pid: process.pid, state: 'ready' });
        return { stop: async () => { stopped = true; await input.onStatus({ pid: process.pid, state: 'stopped' }); } };
      } });
    assert.match(describeFeishuWorkboards(runtime), /正常/);
    assert.equal(JSON.parse(await readFile(join(root, 'workboard-health.json'))).state, 'ready');
    assert.equal(JSON.parse(await readFile(statePath)).runtime.owner, 'connector');
    await runtime.workboards.stop();
    assert.equal(stopped, true);
    assert.match(describeFeishuWorkboards(runtime), /已停止/);

    // Do not corrupt evidence or crash ordinary message delivery on bad state.
    await writeFile(statePath, '{broken');
    const failed = await startFeishuWorkboards(runtime, { configDir: root, configPath: '/config', remote,
      createSync: () => assert.fail('invalid state must not start a writer') });
    assert.equal(failed.getStatus().state, 'failed');
    assert.equal(await readFile(statePath, 'utf8'), '{broken');

    await writeFile(statePath, JSON.stringify({ ...original, runtime: { pid: process.ppid } }));
    const guarded = await startFeishuWorkboards(runtime, { configDir: root, configPath: '/config', remote,
      createSync: () => assert.fail('live old writer must not be duplicated') });
    assert.match(guarded.getStatus().error, /retire the old writer/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('quota pause is isolated, durable and resumes on connector restart with one card', { timeout: 8000 }, async () => {
  const { createServer } = await import('node:http');
  const { WebSocketServer } = await import('ws');
  const { createFeishuWorkboardSync } = await import('../connectors/feishu/workboard-sync.mjs');
  const root = await mkdtemp(join(tmpdir(), 'card-quota-'));
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const pilot = { scope: 'instance', sourceRouteId: 'default', protocolVersion: 2,
    sessions: { old: { chatId: 'chat', cards: [], protocolAfterSeq: 0 } } };
  const visited = [];
  const session = { id: 's', workboardPilot: true, activity: { run: { state: 'running' } }, conversation: { connector: 'feishu', sourceRouteId: 'default',
    target: { chatId: 'chat', chatType: 'p2p', conversationKind: 'main' } } };
  const events = [{ seq: 1, type: 'message', role: 'user', runId: 'r', sourceContext: { connector: 'feishu',
    sourceRouteId: 'default', chatId: 'chat', chatType: 'p2p', messageId: 'input', sender: { openId: 'person' } },
    workboardAdmission: { personId: 'p', identityId: 'i', sourceRouteId: 'default', senderOpenId: 'person' } },
  { seq: 2, type: 'message', role: 'assistant', runId: 'r', source: 'workboard_checklist',
    workboard: { taskId: 'task', goal: '交付', revision: 1, status: 'running', reason: '',
      items: [{ id: 'item', title: '交付', condition: '核对', status: 'pending', evidenceRefs: [] }] } }];
  const remote = { baseUrl: `http://127.0.0.1:${server.address().port}`, ensureAuthCookie: async () => '',
    request: async path => {
      visited.push(path);
      const old = { ...session, id: 'old', activity: { run: { state: 'idle' } } };
      return { response: { ok: true, status: 200 }, json: path.includes('/events')
        ? { events: path.includes('/old/') ? [] : events }
        : path.includes('?sourceId') ? { sessions: [old, session] }
          : { session: path.includes('/old?') ? old : session } };
    } };
  let rejected = true, creates = 0;
  const app = { im: { v1: { message: {
    create: async () => { creates++; if (rejected) throw Object.assign(new Error('monthly quota'), { code: 99991403 });
      return { code: 0, data: { message_id: 'same-card' } }; },
    get: async () => ({ code: 0, data: { items: [{ message_id: 'same-card', chat_id: 'chat', msg_type: 'interactive' }] } }),
    patch: async () => assert.fail('unchanged restart must not patch'),
  } } } };
  let component;
  const statePath = join(root, 'state.json');
  async function start(expected, state) {
    let done; const ready = new Promise(resolve => { done = resolve; });
    component = await createFeishuWorkboardSync({ pilot: state, statePath, app, remote,
      onStatus: async health => { if (health.state === expected) done(health); } });
    return ready;
  }
  try {
    const health = await start('quota_blocked', pilot);
    assert.equal(health.failures.s, 'monthly quota');
    assert.match(visited.find(path => path.includes('view=summary')), /sessions\/s\?/,
      'live task is processed before the stored historical backlog');
    await component.stop();
    assert.equal(creates, 1);
    const paused = JSON.parse(await readFile(statePath));
    assert.equal(paused.quotaBlocked.code, 99991403);
    assert.equal(paused.sessions.s.cards.length, 0, 'definite quota rejection is safe to resume');
    rejected = false;
    await start('ready', paused);
    await component.stop();
    const restored = JSON.parse(await readFile(statePath));
    assert.equal(restored.sessions.s.cards[0].messageId, 'same-card');
    assert.equal(restored.quotaBlocked, undefined);
    assert.equal(creates, 2);
    await start('ready', restored);
    await component.stop();
    assert.equal(creates, 2, 'connector restart reuses the original receipt');
  } finally {
    await component?.stop();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve));
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('activation configures connector-owned state without installing services and refuses a live writer', async () => {
  const { execFile: callback } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFile = promisify(callback);
  const root = await mkdtemp(join(tmpdir(), 'cards-configure-'));
  try {
    const configPath = join(root, 'bot.json');
    await writeFile(configPath, JSON.stringify({ appId: 'test', appSecret: 'test', chatBaseUrl: 'http://127.0.0.1:1', storageDir: root }));
    const args = ['scripts/configure-instance-workboards.mjs', '--config-dir', root,
      '--project-root', process.cwd(), '--base-url', 'http://127.0.0.1:1', '--bot-config', configPath, '--apply'];
    const { stdout } = await execFile(process.execPath, args);
    assert.match(stdout, /"owner":"feishu-connector"/);
    const statePath = join(root, 'workboards/feishu-default.json');
    const before = await readFile(statePath, 'utf8');
    assert.equal(JSON.parse(before).sourceRouteId, 'default');
    assert.equal(JSON.parse(await readFile(join(root, 'workboard-opt-ins.json'))).defaultEnabled, true);
    await writeFile(join(root, 'connector.pid'), String(process.pid));
    await assert.rejects(execFile(process.execPath, args), /Stop the selected Feishu connector/);
    assert.equal(await readFile(statePath, 'utf8'), before);
    const retired = await execFile(process.execPath, ['scripts/feishu-workboard-pilot.mjs', statePath]);
    assert.match(retired.stderr, /Standalone Feishu card services are retired/);
    assert.equal(await readFile(statePath, 'utf8'), before, 'legacy startup never writes or sends');
  } finally { await rm(root, { recursive: true, force: true }); }
});
