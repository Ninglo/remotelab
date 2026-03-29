#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-chat-task-card-'));
const tempBin = join(tempHome, 'bin');
const configDir = join(tempHome, '.config', 'remotelab');

mkdirSync(tempBin, { recursive: true });
mkdirSync(configDir, { recursive: true });

const fakeCodexPath = join(tempBin, 'fake-codex');
writeFileSync(
  fakeCodexPath,
  `#!/usr/bin/env node
const prompt = process.argv[process.argv.length - 1] || '';
const isWorkflowPrompt = prompt.includes('You are updating RemoteLab workflow state');
const isTaskCardPrompt = prompt.includes('You are updating backend-owned task memory for a RemoteLab session.');
const text = isWorkflowPrompt
  ? JSON.stringify({ workflowState: 'done', workflowPriority: 'low', reason: 'turn completed' })
  : isTaskCardPrompt
    ? JSON.stringify({
        mode: 'task',
        summary: '先把当前对话里反复出现的可复用经验接住。',
        goal: '让普通聊天会话也能沉淀后续可重用的经验。',
        knownConclusions: ['经验沉淀更适合放在回合结束后的隐藏整理层。'],
        reusablePatterns: ['先在回合后提炼经验，再决定是否升级成长期规则。'],
        nextSteps: ['继续观察这些经验是否稳定复现'],
      })
    : '我先继续处理，并在回合结束后整理可复用经验。';

console.log(JSON.stringify({ type: 'thread.started', thread_id: isWorkflowPrompt ? 'workflow-thread' : (isTaskCardPrompt ? 'task-card-thread' : 'chat-thread') }));
console.log(JSON.stringify({ type: 'turn.started' }));
console.log(JSON.stringify({
  type: 'item.completed',
  item: { type: 'agent_message', text },
}));
console.log(JSON.stringify({
  type: 'turn.completed',
  usage: { input_tokens: 1, output_tokens: 1 },
}));
process.exit(0);
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

const sessionManager = await import(pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href);

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

try {
  const chatSession = await createSession(tempHome, 'fake-codex', 'Chat Learning', {
    group: 'RemoteLab',
    description: 'Generic chat sessions should accumulate reusable patterns after the turn closes.',
  });

  await sendMessage(chatSession.id, '我们先别做草案，先直接试着积累一下这种经验。', [], {
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });

  await waitFor(
    async () => (await getSession(chatSession.id))?.activity?.run?.state === 'idle',
    'chat session should finish running',
  );

  await waitFor(
    async () => (await getSession(chatSession.id))?.taskCard?.summary === '先把当前对话里反复出现的可复用经验接住。',
    'generic chat session should persist a task card from post-turn suggestion',
  );

  const updatedChatSession = await getSession(chatSession.id);
  assert.equal(updatedChatSession?.taskCard?.mode, 'task');
  assert.deepEqual(
    updatedChatSession?.taskCard?.reusablePatterns,
    ['先在回合后提炼经验，再决定是否升级成长期规则。'],
  );

  const sourcedSession = await createSession(tempHome, 'fake-codex', 'Inbound Mail', {
    sourceId: 'email',
    sourceName: 'Email',
    group: 'Mail',
    description: 'Sourced sessions should not auto-enable the generic chat task-card path.',
  });

  await sendMessage(sourcedSession.id, '这是一条外部来源消息。', [], {
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });

  await waitFor(
    async () => (await getSession(sourcedSession.id))?.activity?.run?.state === 'idle',
    'sourced session should finish running',
  );
  await new Promise((resolve) => setTimeout(resolve, 200));

  const updatedSourcedSession = await getSession(sourcedSession.id);
  assert.equal(updatedSourcedSession?.taskCard || null, null);

  console.log('test-session-chat-task-card-learning: ok');
} finally {
  killAll();
  rmSync(tempHome, { recursive: true, force: true });
}
