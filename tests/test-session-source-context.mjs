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
console.log(JSON.stringify({
  type: 'item.completed',
  item: { type: 'agent_message', text: 'ok' },
}));
console.log(JSON.stringify({
  type: 'turn.completed',
  usage: { input_tokens: 1, output_tokens: 1 },
}));
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

  const outcome = await submitHttpMessage(session.id, 'Alice: hello', [], {
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
  });

  assert.ok(outcome.run?.id, 'message submission should still start a run');

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

  console.log('test-session-source-context: ok');
} finally {
  killAll();
  rmSync(home, { recursive: true, force: true });
}
