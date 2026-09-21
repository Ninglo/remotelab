#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-harness-context-ownership-'));
const tempBin = join(tempHome, 'bin');
const configDir = join(tempHome, '.config', 'remotelab');
const codexSessionsDir = join(tempHome, '.codex', 'sessions', '2026', '03', '10');

mkdirSync(tempBin, { recursive: true });
mkdirSync(configDir, { recursive: true });
mkdirSync(codexSessionsDir, { recursive: true });

const fakeCodexPath = join(tempBin, 'fake-codex');
writeFileSync(
  fakeCodexPath,
  `#!/usr/bin/env node
const prompt = process.argv[process.argv.length - 1] || '';
const isSessionStatePrompt = prompt.includes("You are RemoteLab's single post-turn session-state classifier.");
const text = isSessionStatePrompt
  ? JSON.stringify({
      title: 'Harness Context Ownership',
      space: 'Product',
      group: 'RemoteLab',
      description: 'Keep live context management inside the selected Harness.',
      shouldSetWorkflowState: false,
      workflowState: '',
      workflowPriority: '',
      workSummary: { mode: 'task', summary: 'Harness owns live context management.' },
    })
  : 'Finished without a RemoteLab compaction worker.';
console.log(JSON.stringify({ type: 'thread.started', thread_id: isSessionStatePrompt ? 'state-thread' : 'overflow-thread' }));
console.log(JSON.stringify({ type: 'turn.started' }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
`,
  'utf8',
);
chmodSync(fakeCodexPath, 0o755);

writeFileSync(join(configDir, 'tools.json'), JSON.stringify([{
  id: 'fake-codex',
  name: 'Fake Codex',
  command: 'fake-codex',
  runtimeFamily: 'codex-json',
  models: [{ id: 'fake-model', label: 'Fake model' }],
  reasoning: { kind: 'enum', label: 'Reasoning', levels: ['low'], default: 'low' },
}], null, 2));

writeFileSync(
  join(codexSessionsDir, 'rollout-2026-03-10T12-17-55-overflow-thread.jsonl'),
  `${JSON.stringify({
    timestamp: '2026-03-10T04:18:17.666Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 101, output_tokens: 12, total_tokens: 113 },
        last_token_usage: { input_tokens: 101, output_tokens: 12, total_tokens: 113 },
        model_context_window: 100,
      },
    },
  })}\n`,
  'utf8',
);

setIsolatedTestHome(tempHome);
process.env.REMOTELAB_MACHINE_CODEX_HOME = join(tempHome, '.codex');
process.env.REMOTELAB_MEMORY_WRITEBACK = 'off';
process.env.PATH = `${tempBin}:${process.env.PATH}`;

const sessionManager = await import(pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href);
const history = await import(pathToFileURL(join(repoRoot, 'chat', 'history.mjs')).href);
const {
  createSession,
  getHistory,
  getSession,
  killAll,
  listSessions,
  sendMessage,
} = sessionManager;

async function waitFor(predicate, description, timeoutMs = 8000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${description}`);
}

try {
  const session = await createSession(tempHome, 'fake-codex', '', {
    group: 'RemoteLab',
  });
  await sendMessage(session.id, 'Let the selected Harness own context compaction.', [], {
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });

  await waitFor(
    async () => (await getSession(session.id))?.activity?.run?.state === 'idle',
    'foreground run to finish',
  );
  await waitFor(
    async () => (await getSession(session.id))?.name === 'Harness Context Ownership',
    'post-turn Session-state classifier to finish',
  );

  assert.equal(
    await history.getContextHead(session.id),
    null,
    'RemoteLab must not replace a Harness thread with its own continuation summary after overflow metrics',
  );
  assert.equal(
    (await getSession(session.id))?.codexThreadId,
    'overflow-thread',
    'the Harness resume identity must remain intact',
  );
  assert.equal(
    (await listSessions({ includeArchived: true })).some((entry) => entry.internalRole === 'context_compactor'),
    false,
    'ordinary completion must not create a hidden RemoteLab compactor Session',
  );
  assert.equal(
    (await getHistory(session.id)).some((event) => event.operation === 'compact_context'),
    false,
    'ordinary completion must not append RemoteLab compaction operations',
  );

  console.log('harness context ownership: RemoteLab auto-compaction remains retired');
} finally {
  await killAll();
  delete process.env.REMOTELAB_MACHINE_CODEX_HOME;
  delete process.env.REMOTELAB_MEMORY_WRITEBACK;
  rmSync(tempHome, { recursive: true, force: true });
}
