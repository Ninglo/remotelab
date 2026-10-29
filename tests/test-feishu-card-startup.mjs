import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'feishu-card-startup-'));
setIsolatedTestHome(home);
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Blocked by card recovery: ${label}`)), 2000);
    })]);
  } finally { clearTimeout(timer); }
}

try {
  const { startFeishuCardRecovery } = await import('../connectors/feishu/card-startup.mjs');
  const { createParticipationController } = await import('../connectors/feishu/participation-state.mjs');
  const { createRecordStore } = await import('../lib/durable-records.mjs');
  const { handleMessage } = await import('../scripts/feishu-connector.mjs');
  const source = { chatId: 'group', tenantKey: 'tenant', chatType: 'group', chatMode: 'group',
    sender: { senderType: 'user', openId: 'human' }, mentions: [], messageType: 'text' };
  function fixture(name, options = {}) {
    const calls = { cancelled: [], cleaned: [], cards: [], submitted: [], observed: [] };
    const runtime = { config: { storageDir: join(home, name), sourceRouteId: 'bot',
      responsePolicy: { group: 'all' }, groups: { group: { participationMode: 'ambient',
        participationControls: true, participationStatusMessageId: 'om_existing', jevReactions: false } } },
      storagePaths: {}, botIdentity: { openId: 'bot' }, groupConfiguration: {},
      appClient: { im: { v1: { message: {
        get: async () => ({ code: 0, data: { items: [{ create_time: String(Date.now()) }] } }),
        patch: async payload => { calls.cards.push(payload); return { code: 0 }; },
        create: async () => { throw new Error('Recovery must reuse the existing card'); },
      } } } } };
    runtime.participation = createParticipationController(runtime, {
      resolveSession: async () => 's1', cancelSession: async id => calls.cancelled.push(id),
      cleanup: async record => calls.cleaned.push(record.epoch), getConfiguration: async () => null,
      ...options,
    });
    const records = createRecordStore(join(runtime.config.storageDir, 'participation-state'));
    const seed = async (mode = 'active', stopPending = false) => {
      const record = await runtime.participation.state(source);
      await records.mutate(record.key, () => ({ ...record, mode, stopPending, modeOverride: true, epoch: 1,
        sessionId: 's1', cardMessageId: 'om_existing', pinnedMessageId: 'om_existing', cardCreatedAt: Date.now() }));
    };
    const helpers = {
      enrichSummaryWithChatMetadata: async (_runtime, summary) => summary,
      loadAcceptedObservation: async () => ({ accepted: true, recent: [] }),
      observeRemoteLabMessage: async (_runtime, summary) => {
        calls.observed.push(summary.messageId);
        return { sessionId: 's1', observation: { eventSeq: calls.observed.length, recent: [] } };
      },
      submitRemoteLabRequest: async (_runtime, summary) => {
        calls.submitted.push(summary.messageId);
        return { sessionId: 's1' };
      },
    };
    const send = (messageId, messageText, extra = {}) => bounded(handleMessage(runtime,
      { ...source, messageId, messageText, ...extra }, 'test', helpers), messageId);
    return { runtime, calls, seed, send };
  }

  // All three background workers can be blocked while real intake completes
  // from durable settings, including subsequent controls and invitations.
  const f = fixture('blocked');
  await f.seed();
  const patchStarted = deferred(), patch = deferred(), workboards = deferred(), projects = deferred();
  f.runtime.appClient.im.v1.message.patch = async payload => {
    f.calls.cards.push(payload);
    patchStarted.resolve();
    return patch.promise;
  };
  let stopped = 0;
  const recovery = startFeishuCardRecovery({
    startWorkboards: () => workboards.promise,
    startProjectCards: () => projects.promise,
    restoreParticipation: shouldContinue => f.runtime.participation.restore({ shouldContinue }),
  });
  try {
    await bounded(patchStarted.promise, 'start recovery');
    assert.equal((await f.send('active', '处理这个问题')).sessionId, 's1');
    assert.equal((await f.send('listen', '先旁听')).participationControl, true);
    assert.equal((await f.send('discussion', '我们继续讨论预算')).observedOnly, true);
    assert.deepEqual(f.calls.submitted, ['active']);
    assert.equal((await f.send('pause', '暂停接收消息')).participationControl, true);
    assert.equal((await f.send('private', '这段别读')).reason, 'participation_paused');
    assert.deepEqual(f.calls.observed, ['discussion']);
    assert.equal((await f.send('invited', '@_bot 帮忙看看', { mentions: [{ openId: 'bot' }] })).sessionId, 's1');
    assert.equal((await f.runtime.participation.state(source)).mode, 'paused');
    assert.deepEqual(f.calls.submitted, ['active', 'invited']);
    assert.deepEqual(f.calls.cancelled, ['s1', 's1']);
  } finally {
    patch.resolve({ code: 0 });
    workboards.resolve({ stop: async () => { stopped++; } });
    projects.resolve({ stop: async () => { stopped++; } });
    await recovery.ready;
    await f.runtime.participation.idle();
    await recovery.stop();
  }
  assert.equal(stopped, 2);
  assert.match(f.calls.cards.at(-1).data.content, /暂停接收/, 'late card refresh uses current settings');

  // Metadata can finish after a human resumes. Neither a pending old stop nor
  // old cleanup may revert that newer control or cancel its new work.
  for (const pending of [false, true]) {
    const resolving = deferred(), metadata = deferred();
    let first = true;
    const race = fixture(`stale-${pending}`, { resolveSource: async saved => {
      if (first) { first = false; resolving.resolve(); await metadata.promise; }
      return saved;
    } });
    await race.seed('listening', pending);
    const restore = race.runtime.participation.restore();
    try {
      await bounded(resolving.promise, 'metadata read');
      await bounded(race.runtime.participation.change({ ...source, messageId: 'resume' }, 'active'), 'new control');
    } finally { metadata.resolve(); await restore; await race.runtime.participation.idle(); }
    const current = await race.runtime.participation.state(source);
    assert.equal(current.mode, 'active');
    assert.equal(current.epoch, 2);
    assert.deepEqual(race.calls.cancelled, []);
    assert.deepEqual(race.calls.cleaned, []);
  }

  // Failures are isolated and components that finish opening after shutdown
  // are stopped instead of leaving new watchers alive.
  const warnings = [], opened = deferred(), late = deferred(), restoreGate = deferred();
  let lateStopped = 0, projectStopped = 0, continuedAfterStop;
  const closing = startFeishuCardRecovery({
    startWorkboards: async () => { opened.resolve(); return late.promise; },
    startProjectCards: async () => ({ stop: async () => { projectStopped++; } }),
    restoreParticipation: async shouldContinue => { await restoreGate.promise; continuedAfterStop = shouldContinue(); },
  });
  await bounded(opened.promise, 'worker open');
  const closingDone = closing.stop();
  late.resolve({ stop: async () => { lateStopped++; } });
  restoreGate.resolve();
  await closingDone;
  await closing.ready;
  assert.equal(lateStopped, 1);
  assert.equal(projectStopped, 1);
  assert.equal(continuedAfterStop, false);
  const failed = startFeishuCardRecovery({
    startWorkboards: async () => { throw new Error('auth offline'); },
    startProjectCards: async () => ({ stop: async () => {} }),
    restoreParticipation: async () => { throw new Error('provider offline'); },
    warn: (name, error) => warnings.push([name, error.message]),
  });
  await failed.ready;
  await failed.stop();
  assert.deepEqual(warnings.sort(), [['participation', 'provider offline'], ['workboards', 'auth offline']]);

  const main = await readFile(new URL('../scripts/feishu-connector.mjs', import.meta.url), 'utf8');
  const localSettings = main.indexOf('await groupConfigurationController(runtime).restore()');
  const intake = main.indexOf('await wsClient.start({ eventDispatcher })');
  const cards = main.indexOf('cardRecovery = startFeishuCardRecovery(');
  assert.ok(localSettings > 0 && localSettings < intake && intake < cards,
    'local settings load before reception; remote card recovery starts afterward');
  console.log('Feishu card startup: blocked/failed recovery, message intake, mode controls, stale stops and shutdown passed');
} finally { await rm(home, { recursive: true, force: true }); }
