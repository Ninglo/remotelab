#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-chat-work-summary-'));
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
const isSecondState = prompt.includes('SECOND_STATE');
const isFirstState = prompt.includes('FIRST_STATE') && !isSecondState;
const summary = isSecondState
  ? '第二轮状态必须最终生效。'
  : isFirstState
    ? '第一轮延迟状态不应覆盖第二轮。'
    : '先把当前对话里反复出现的可复用经验接住。';
const text = isSessionStatePrompt
  ? JSON.stringify({
      title: '统一会话状态',
      space: 'Product',
      group: 'RemoteLab',
      description: '在一个分类调用中维护跨 Harness 会话状态。',
      shouldSetWorkflowState: true,
      workflowState: 'done',
      workflowPriority: 'low',
      workSummary: {
        mode: 'task',
        summary,
        goal: '让所有 Harness 共用同一份当前工作状态。',
        knownConclusions: ['会话分类与当前工作摘要应在同一个回合后调用里更新。'],
        reusablePatterns: ['用一个 provider-neutral 状态投影替代多个隐藏分类器。'],
        nextSteps: ['继续观察统一分类结果是否稳定'],
      },
    })
  : '我先继续处理，并在回合结束后整理统一会话状态。';
const delayMs = isFirstState ? 300 : (isSecondState ? 20 : 0);

console.log(JSON.stringify({ type: 'thread.started', thread_id: isSessionStatePrompt ? 'session-state-thread' : 'chat-thread' }));
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
setTimeout(() => process.exit(0), delayMs + 10);
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

setIsolatedTestHome(tempHome);
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
    async () => (await getSession(chatSession.id))?.workState?.summary?.summary === '先把当前对话里反复出现的可复用经验接住。',
    'generic chat session should persist a work summary from post-turn suggestion',
  );

  const updatedChatSession = await getSession(chatSession.id);
  assert.equal(updatedChatSession?.workState?.summary?.mode, 'task');
  assert.deepEqual(
    updatedChatSession?.workState?.summary?.reusablePatterns,
    ['用一个 provider-neutral 状态投影替代多个隐藏分类器。'],
  );
  assert.equal(updatedChatSession?.workflowState, 'done');
  assert.equal(updatedChatSession?.space, 'Product');

  const raceSession = await createSession(tempHome, 'fake-codex', 'State race', {
    group: 'RemoteLab',
    description: 'A later turn must win over a delayed classifier from an earlier turn.',
  });
  await sendMessage(raceSession.id, 'FIRST_STATE', [], {
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });
  await waitFor(
    async () => (await getSession(raceSession.id))?.activity?.run?.state === 'idle',
    'first race turn should finish',
  );
  await new Promise((resolve) => setTimeout(resolve, 60));
  await sendMessage(raceSession.id, 'SECOND_STATE', [], {
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  });
  await waitFor(
    async () => (await getSession(raceSession.id))?.workState?.summary?.summary === '第二轮状态必须最终生效。',
    'the latest turn should own the final classified work state',
  );
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(
    (await getSession(raceSession.id))?.workState?.summary?.summary,
    '第二轮状态必须最终生效。',
    'a delayed classifier from an older turn must not overwrite newer state',
  );

  const sourcedSession = await createSession(tempHome, 'fake-codex', 'Inbound Mail', {
    sourceId: 'email',
    sourceName: 'Email',
    group: 'Mail',
    description: 'Sourced sessions should use the same provider-neutral state classifier.',
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
  await waitFor(
    async () => (await getSession(sourcedSession.id))?.workState?.summary?.summary === '先把当前对话里反复出现的可复用经验接住。',
    'sourced session should receive the same cross-Harness work summary',
  );

  console.log('test-session-state-classification: ok');
} finally {
  killAll();
  rmSync(tempHome, { recursive: true, force: true });
}
