#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-reply-publication-'));
const tempBin = join(tempHome, 'bin');
const configDir = join(tempHome, '.config', 'remotelab');
mkdirSync(tempBin, { recursive: true });
mkdirSync(configDir, { recursive: true });

const fakeCodexPath = join(tempBin, 'fake-codex');
writeFileSync(fakeCodexPath, `#!/usr/bin/env node
if (process.argv.join(' ').includes('hold-entry-notice')) {
  const fs = require('node:fs');
  while (!fs.existsSync(${JSON.stringify(join(tempHome, 'release-entry-test'))})) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
}
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'reply-publication-thread' }));
console.log(JSON.stringify({ type: 'turn.started' }));
console.log(JSON.stringify({
  type: 'item.completed',
  item: { type: 'agent_message', text: '主 Harness 已经直接完成并交付结果。' },
}));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
`, 'utf8');
chmodSync(fakeCodexPath, 0o755);

writeFileSync(join(configDir, 'tools.json'), JSON.stringify([{
  id: 'fake-codex',
  name: 'Fake Codex',
  command: 'fake-codex',
  runtimeFamily: 'codex-json',
  models: [{ id: 'fake-model', label: 'Fake model' }],
  reasoning: { kind: 'enum', label: 'Reasoning', levels: ['low'], default: 'low' },
}], null, 2), 'utf8');

process.env.HOME = tempHome;
process.env.REMOTELAB_CONFIG_DIR = configDir;
process.env.REMOTELAB_WORK_ROOT_DIR = join(tempHome, 'workspace');
process.env.REMOTELAB_MEMORY_WRITEBACK = 'off';
process.env.REMOTELAB_PUBLIC_BASE_URL = 'https://remote.example.test';
delete process.env.REMOTELAB_INSTANCE_ROOT;
process.env.PATH = `${tempBin}:${process.env.PATH}`;

const {
  createSession,
  getRunState,
  getSession,
  updateSessionRuntimePreferences,
  getSessionReplyPublication,
  killAll,
  sendMessage,
  submitHttpMessage,
} = await import(pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href);
const { getRun, getRunManifest } = await import(pathToFileURL(join(repoRoot, 'chat', 'runs.mjs')).href);
const { requests } = await import('../chat/requests.mjs');
const { claimSourceDelivery, completeSourceDelivery } = await import('../chat/source-deliveries.mjs');
const { buildSessionEntryDeliveries } = await import('../chat/session-entry-notification.mjs');

async function waitFor(predicate, description, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

try {
  const session = await createSession(tempHome, 'fake-codex', 'Direct Reply Publication', {
    space: 'Product',
    group: 'RemoteLab',
    description: 'Verify direct publication after the selected Harness completes.',
  });
  const outcome = await sendMessage(session.id, '直接完成这项工作。', [], {
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });

  const responseId = outcome.response?.id;
  const runId = outcome.run?.id;
  assert.ok(responseId);
  assert.ok(runId);

  await waitFor(
    async () => (await getRunState(runId))?.state === 'completed',
    'main Harness run to complete',
  );
  await waitFor(
    async () => (await getSessionReplyPublication(session.id, responseId))?.state === 'ready',
    'reply publication to become ready directly',
  );

  const publication = await getSessionReplyPublication(session.id, responseId);
  assert.equal(publication?.resolution, 'accepted_as_is');
  assert.equal(publication?.rootRunId, runId);
  assert.equal(publication?.finalRunId, runId);
  assert.deepEqual(publication?.continuationRunIds, []);
  assert.equal(publication?.payload?.text, '主 Harness 已经直接完成并交付结果。');

  assert.equal(Object.hasOwn(await getRun(runId), 'replyPublication'), false, 'publication has no independently mutable persisted state');
  const recoveredPublication = await getSessionReplyPublication(session.id, responseId);
  assert.equal(
    recoveredPublication?.state,
    'ready',
    'publication reads the immutable request result',
  );
  assert.equal(recoveredPublication?.resolution, 'accepted_as_is');

  const secondOutcome = await sendMessage(session.id, '继续当前会话。', [], {
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });
  assert.ok(secondOutcome.run?.id, 'a later message should start a Harness run directly');
  assert.equal(secondOutcome.queued, false);
  assert.notEqual(secondOutcome.response?.state, 'checking');

  const connectorSession = await createSession(tempHome, 'fake-codex', 'Feishu connector session', {
    sourceId: 'feishu',
    sourceName: 'Feishu',
    externalTriggerId: 'feishu:topic:chat-1:thread-1',
  });
  const connectorOptions = {
    requestId: 'connector-first',
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
    sourceDelivery: { connector: 'feishu', sourceRouteId: 'bot-2', target: { chatId: 'test-chat', messageId: 'first-message', threadId: 'test-thread' } },
  };
  assert.deepEqual(buildSessionEntryDeliveries(connectorSession, { userMessageCount: 1 }, connectorOptions), [], 'pre-existing history never gets a retroactive notice');
  assert.deepEqual(buildSessionEntryDeliveries(connectorSession, { userMessageCount: 0 }, { ...connectorOptions, internalOperation: 'trigger_delivery' }), []);
  assert.deepEqual(buildSessionEntryDeliveries(connectorSession, { userMessageCount: 0 }, { ...connectorOptions, recordUserMessage: false }), []);
  assert.deepEqual(buildSessionEntryDeliveries(session, { userMessageCount: 0 }, connectorOptions), [], 'browser sessions do not receive connector notices');
  const firstConnectorOutcome = await submitHttpMessage(connectorSession.id, 'hold-entry-notice 首轮消息。', [], connectorOptions);
  const expectedSessionUrl = `https://remote.example.test/?session=${connectorSession.id}&tab=sessions`;
  const earlyClaim = await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'bot-2' });
  assert.equal(earlyClaim?.delivery?.kind, 'session_entry', 'entry can be sent while the first model response is still pending');
  assert.ok(earlyClaim.delivery.text.includes(expectedSessionUrl));
  assert.match(earlyClaim.delivery.text, /模型：fake-model/);
  assert.match(earlyClaim.delivery.text, /Effort：low/);
  assert.match(earlyClaim.delivery.text, /Harness：fake-codex/);
  await waitFor(async () => (await getSession(connectorSession.id)).model === 'fake-model', 'session metadata to reflect the admitted runtime');
  assert.equal((await getSession(connectorSession.id)).effort, 'low');
  const admitted = await requests.byResponse(connectorSession.id, firstConnectorOutcome.response.id);
  assert.equal(admitted.runtimeSelection.model, 'fake-model');
  assert.equal(admitted.runtimeSelection.effort, 'low');
  const queuedOptions = { requestId: 'connector-queued-defaults' };
  const queuedOutcome = await submitHttpMessage(connectorSession.id, 'Use the saved runtime after the blocked turn.', [], queuedOptions);
  assert.equal(queuedOutcome.queued, true);
  await updateSessionRuntimePreferences(connectorSession.id, { model: 'changed-after-admission', effort: 'high' });
  const queuedReplay = await submitHttpMessage(connectorSession.id, 'Use the saved runtime after the blocked turn.', [], queuedOptions);
  assert.equal(queuedReplay.duplicate, true, 'changing defaults must not change the original request fingerprint');
  assert.equal((await requests.byResponse(connectorSession.id, queuedOutcome.response.id)).runtimeSelection.model, 'fake-model');
  assert.equal(earlyClaim.delivery.target.threadId, 'test-thread');
  assert.equal((await requests.byResponse(connectorSession.id, firstConnectorOutcome.response.id)).result, null);
  await completeSourceDelivery(earlyClaim.delivery.id, earlyClaim.leaseId, { externalId: 'early-entry-message' });
  assert.equal((await submitHttpMessage(connectorSession.id, 'hold-entry-notice 首轮消息。', [], connectorOptions)).duplicate, true);
  assert.equal(await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'bot-2' }), null, 'replayed submission does not resend the link');
  writeFileSync(join(tempHome, 'release-entry-test'), 'continue');
  await waitFor(
    async () => (await getSessionReplyPublication(connectorSession.id, firstConnectorOutcome.response?.id))?.state === 'ready',
    'first connector reply publication to become ready',
  );
  const firstConnectorPublication = await getSessionReplyPublication(
    connectorSession.id,
    firstConnectorOutcome.response?.id,
  );
  assert.equal(firstConnectorPublication?.payload?.sessionEntry, undefined);
  assert.equal(firstConnectorPublication?.payload?.text, '主 Harness 已经直接完成并交付结果。', 'final reply does not repeat the early entry');
  const finalClaim = await claimSourceDelivery({ connector: 'feishu', sourceRouteId: 'bot-2' });
  assert.equal(finalClaim?.delivery?.kind, 'content');
  assert.equal(finalClaim.delivery.text, firstConnectorPublication.payload.text);
  await completeSourceDelivery(finalClaim.delivery.id, finalClaim.leaseId, { externalId: 'final-reply-message' });

  await waitFor(async () => (await getRunState(queuedOutcome.run.id))?.state === 'completed', 'queued run completion');
  const queuedManifest = await getRunManifest(queuedOutcome.run.id);
  assert.equal(queuedManifest.options.model, 'fake-model', 'the runner must use the admitted selection after preferences change');
  assert.equal(queuedManifest.options.effort, 'low');
  assert.equal((await getSession(connectorSession.id)).model, 'fake-model');

  const laterConnectorOutcome = await submitHttpMessage(connectorSession.id, '后续消息。', [], { ...connectorOptions, requestId: 'connector-later' });
  assert.equal((await requests.byResponse(connectorSession.id, laterConnectorOutcome.response.id)).deliveries.length, 0);
  await waitFor(
    async () => (await getSessionReplyPublication(connectorSession.id, laterConnectorOutcome.response?.id))?.state === 'ready',
    'later connector reply publication to become ready',
  );
  const laterConnectorPublication = await getSessionReplyPublication(
    connectorSession.id,
    laterConnectorOutcome.response?.id,
  );
  assert.equal(laterConnectorPublication?.payload?.sessionEntry, undefined);
  assert.doesNotMatch(laterConnectorPublication?.payload?.text || '', new RegExp(connectorSession.id));
  const legacySession = await createSession(tempHome, 'fake-codex', 'Connector without outbox', { sourceId: 'wechat' });
  const legacyOutcome = await sendMessage(legacySession.id, 'Normal reply.', [], { tool: 'fake-codex', model: 'fake-model' });
  await waitFor(async () => (await getSessionReplyPublication(legacySession.id, legacyOutcome.response.id))?.state === 'ready', 'legacy connector response');
  assert.ok((await getSessionReplyPublication(legacySession.id, legacyOutcome.response.id)).payload.sessionEntry?.url.includes(legacySession.id), 'adapters without the shared outbox retain their existing first-reply link');
  await waitFor(async () => (await getRunState(secondOutcome.run.id))?.finalizedAt, 'second request to finish');
} finally {
  await killAll();
  rmSync(tempHome, { recursive: true, force: true });
}

console.log('test-reply-publication: ok');
