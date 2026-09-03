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
delete process.env.REMOTELAB_INSTANCE_ROOT;
process.env.PATH = `${tempBin}:${process.env.PATH}`;

const {
  createSession,
  getRunState,
  getSessionReplyPublication,
  killAll,
  sendMessage,
} = await import(pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href);
const { updateRun } = await import(pathToFileURL(join(repoRoot, 'chat', 'runs.mjs')).href);

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

  await updateRun(runId, (run) => ({
    ...run,
    replyPublication: {
      ...run.replyPublication,
      state: 'running',
      resolution: '',
      readyAt: null,
    },
  }));
  const recoveredPublication = await getSessionReplyPublication(session.id, responseId);
  assert.equal(
    recoveredPublication?.state,
    'ready',
    'a terminal run must repair a stale non-terminal reply publication',
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
} finally {
  killAll();
  rmSync(tempHome, { recursive: true, force: true });
}

console.log('test-reply-publication: ok');
