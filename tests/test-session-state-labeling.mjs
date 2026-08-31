#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-state-labeling-'));
const tempBin = join(tempHome, 'bin');
const configDir = join(tempHome, '.config', 'remotelab');

mkdirSync(tempBin, { recursive: true });
mkdirSync(configDir, { recursive: true });

const fakeCodexPath = join(tempBin, 'fake-codex');
writeFileSync(
  fakeCodexPath,
  `#!/usr/bin/env node
const prompt = process.argv[process.argv.length - 1] || '';
const isSessionStatePrompt = prompt.includes("You are RemoteLab's single post-turn session-state classifier.");
const delayMs = isSessionStatePrompt ? 20 : 220;
const text = isSessionStatePrompt
  ? JSON.stringify({
      title: 'RemoteLab Rename Flow',
      space: 'Product',
      group: 'RemoteLab',
      description: 'Keep labels aligned with the latest completed turn.',
      shouldSetWorkflowState: true,
      workflowState: 'done',
      workflowPriority: 'low',
      workSummary: {
        mode: 'task',
        summary: '统一更新标题、分组、工作流与当前工作摘要。',
        goal: '用一次持续分类保持会话状态正确。',
      },
    })
  : 'main task finished';

console.log(JSON.stringify({ type: 'thread.started', thread_id: isSessionStatePrompt ? 'session-state-thread' : 'run-thread' }));
console.log(JSON.stringify({ type: 'turn.started' }));
setTimeout(() => {
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text },
  }));
  console.log(JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
}, delayMs);
setTimeout(() => process.exit(0), delayMs + 20);
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

process.env.HOME = tempHome;
process.env.PATH = `${tempBin}:${process.env.PATH}`;

const sessionManager = await import(
  pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href
);

const {
  createSession,
  getSession,
  sendMessage,
  killAll,
} = sessionManager;

async function waitFor(predicate, description, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${description}`);
}

const session = await createSession(tempHome, 'fake-codex', '', {
});

await sendMessage(session.id, 'Refactor the naming flow so one post-turn classifier keeps all session state aligned.', [], {
  tool: 'fake-codex',
  model: 'fake-model',
  effort: 'low',
});

await waitFor(
  async () => (await getSession(session.id))?.activity?.run?.state === 'running',
  'session should enter running state',
);

const running = await getSession(session.id);
assert.equal(running?.name, 'Refactor the…', 'the deterministic draft title should be available while the Harness runs');
assert.equal(running?.autoRenamePending, true);
assert.equal(running?.space || '', '', 'semantic classification should wait for the completed turn');

await waitFor(
  async () => (await getSession(session.id))?.activity?.run?.state === 'idle',
  'session should finish running',
);

await waitFor(
  async () => {
    const current = await getSession(session.id);
    return current?.name === 'Rename Flow'
      && current?.group === 'RemoteLab'
      && current?.description === 'Keep labels aligned with the latest completed turn.'
      && current?.autoRenamePending === false;
  },
  'one post-turn classifier should update all session state after the Harness completes',
);

const finished = await getSession(session.id);
assert.equal(finished?.name, 'Rename Flow', 'finished session should adopt the final AI title after the first turn');
assert.equal(finished?.group, 'RemoteLab', 'finished session should receive the classified Project group');
assert.equal(
  finished?.description,
  'Keep labels aligned with the latest completed turn.',
  'finished session should keep the classified description',
);
assert.equal(finished?.autoRenamePending, false, 'post-turn rename should clear autoRenamePending');

killAll();
rmSync(tempHome, { recursive: true, force: true });

console.log('test-session-state-labeling: ok');
