#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const home = mkdtempSync(join(tmpdir(), 'remotelab-session-source-context-'));
const configDir = join(home, '.config', 'remotelab');
const binDir = join(home, '.local', 'bin');
const fakeCodexPath = join(binDir, 'fake-codex');

mkdirSync(configDir, { recursive: true });
mkdirSync(binDir, { recursive: true });

writeFileSync(
  fakeCodexPath,
  `#!/usr/bin/env node
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-source-context' }));
console.log(JSON.stringify({ type: 'turn.started' }));
setTimeout(() => {
console.log(JSON.stringify({
  type: 'item.completed',
  item: { type: 'agent_message', text: 'ok' },
}));
console.log(JSON.stringify({
  type: 'turn.completed',
  usage: { input_tokens: 1, output_tokens: 1 },
}));
}, 1500);
`,
  'utf8',
);
chmodSync(fakeCodexPath, 0o755);

writeFileSync(
  join(configDir, 'tools.json'),
  JSON.stringify(
    [
      {
        id: 'fake-codex',
        name: 'Fake Codex',
        command: 'fake-codex',
        runtimeFamily: 'codex-json',
        models: [{ id: 'fake-model', label: 'Fake model' }],
        reasoning: {
          kind: 'enum',
          label: 'Reasoning',
          levels: ['low'],
          default: 'low',
        },
      },
    ],
    null,
    2,
  ),
  'utf8',
);

setIsolatedTestHome(home);
process.env.PATH = `${binDir}:${process.env.PATH}`;

const sessionManager = await import(
  pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href
);
const { getRunManifest } = await import('../chat/runs.mjs');
const { requests } = await import('../chat/requests.mjs');
async function waitFor(predicate) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('Timed out waiting for request preparation');
}

const {
  createSession,
  getHistory,
  getSessionSourceContext,
  killAll,
  submitHttpMessage,
} = sessionManager;

try {
  const session = await createSession(home, 'fake-codex', 'Feishu source context test', {
    sourceId: 'feishu',
    sourceName: 'Feishu',
    sourceContext: {
      connector: 'feishu',
      chatType: 'group',
      chatId: 'chat_test_group_1',
      chatName: 'Family Group',
    },
  });

  const firstOptions = {
    requestId: 'req-source-context-1',
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
    sourceContext: {
      connector: 'feishu',
      messageId: 'msg_source_context_1',
      sender: { name: 'Alice' },
      mentions: [{ name: 'Bob', token: '@_user_1' }],
    },
  };
  const outcome = await submitHttpMessage(session.id, 'hello', [], firstOptions);

  assert.ok(outcome.run?.id, 'message submission should still start a run');
  await waitFor(async () => (await getHistory(session.id)).some(event => event.type === 'manager_context'));

  const sourceContext = await getSessionSourceContext(session.id);
  assert.deepEqual(sourceContext?.session, {
    connector: 'feishu',
    chatType: 'group',
    chatId: 'chat_test_group_1',
    chatName: 'Family Group',
  });
  assert.equal(sourceContext?.requestId, 'req-source-context-1');
  assert.deepEqual(sourceContext?.message, {
    connector: 'feishu',
    messageId: 'msg_source_context_1',
    sender: { name: 'Alice' },
    mentions: [{ name: 'Bob', token: '@_user_1' }],
  });

  const history = await getHistory(session.id);
  const latestUserEvent = [...history].reverse().find((event) => event?.type === 'message' && event.role === 'user');
  assert.equal(latestUserEvent?.sourceContext?.messageId, 'msg_source_context_1');
  assert.equal(latestUserEvent?.sourceContext?.sender?.name, 'Alice');
  assert.equal(latestUserEvent?.content, 'hello');
  const firstManifest = await getRunManifest(outcome.run.id);
  const firstContext = history.find(event => event.type === 'manager_context').content;
  assert.equal(firstContext, firstManifest.managerTurnContext);
  assert.ok(firstManifest.prompt.includes(`<private>\n${firstContext}\n</private>`));
  assert.match(firstContext, /msg_source_context_1/);
  assert.doesNotMatch(firstContext, /threadId/);

  // Request options are durable snapshots; queueing later input cannot overwrite
  // the sender/message attached to an earlier turn or its replay.
  const secondOptions = { ...firstOptions, requestId: 'req-source-context-2', sourceContext: {
    connector: 'feishu', messageId: 'msg_source_context_2', threadId: 'thread-2', sender: { name: 'Bob' },
    commentQuote: 'long quoted context '.repeat(1500),
  } };
  const second = await submitHttpMessage(session.id, 'second body', [], secondOptions);
  assert.equal(second.queued, true);
  const secondSnapshot = structuredClone(secondOptions.sourceContext);
  secondOptions.sourceContext.messageId = 'mutated-after-admission';
  await waitFor(async () => (await getHistory(session.id)).some(event => event.type === 'manager_context' && event.runId === second.run.id));
  const secondManifest = await getRunManifest(second.run.id);
  const secondHistory = await getHistory(session.id);
  const secondContext = secondHistory.find(event => event.type === 'manager_context' && event.runId === second.run.id).content;
  assert.equal(secondContext, secondManifest.managerTurnContext);
  assert.ok(secondManifest.prompt.includes(`<private>\n${secondContext}\n</private>`));
  assert.match(secondContext, /msg_source_context_2/);
  assert.match(secondContext, /thread-2/);
  assert.match(secondContext, /truncated/);
  assert.doesNotMatch(secondContext, /msg_source_context_1|Alice|mutated-after-admission/);
  assert.deepEqual((await getSessionSourceContext(session.id, { requestId: 'req-source-context-2' })).message, secondSnapshot);
  const duplicate = await submitHttpMessage(session.id, 'hello', [], firstOptions);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.run.id, outcome.run.id);
  assert.equal((await getRunManifest(outcome.run.id)).managerTurnContext, firstContext);
  assert.equal((await getHistory(session.id)).filter(event => event.type === 'manager_context' && event.runId === outcome.run.id).length, 1);
  assert.equal((await requests.byRequest(session.id, 'req-source-context-2')).options.sourceContext.messageId, 'msg_source_context_2');

  console.log('test-session-source-context: ok');
} finally {
  await killAll();
  rmSync(home, { recursive: true, force: true });
}
