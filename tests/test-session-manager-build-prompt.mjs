#!/usr/bin/env node
import assert from 'assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'remotelab-build-prompt-'));
process.env.HOME = tempHome;

await fs.mkdir(path.join(tempHome, '.config', 'remotelab'), { recursive: true });
await fs.writeFile(
  path.join(tempHome, '.config', 'remotelab', 'tools.json'),
  `${JSON.stringify([
    {
      id: 'micro-agent',
      name: 'Micro Agent',
      command: 'codex',
      runtimeFamily: 'codex-json',
      promptMode: 'bare-user',
      flattenPrompt: true,
      models: [{ id: 'gpt-5.4', label: 'gpt-5.4' }],
      reasoning: { kind: 'none', label: 'Thinking' },
    },
  ], null, 2)}\n`,
  'utf8',
);

const { buildPrompt } = await import('../chat/session-manager.mjs');

const baseSession = {
  systemPrompt: '',
  visitorId: '',
  claudeSessionId: null,
  codexThreadId: null,
  activeAgreements: [
    '默认用自然连贯的段落表达，不要自己起标题和列表。',
    'Agent 更像执行器，Manager 负责统一任务语义和边界。',
  ],
};

const freshPrompt = await buildPrompt(
  'session-test-1',
  baseSession,
  '聊一下产品方向。',
  'codex',
  'codex',
  null,
  { skipSessionContinuation: true },
);

assert.match(freshPrompt, /<private>[\s\S]*Manager note: RemoteLab remains the manager for this turn/);
assert.match(freshPrompt, /User message:/);
assert.match(freshPrompt, /do not mirror its headings, bullets, or checklist structure back to the user/);
assert.match(freshPrompt, /active working agreements/);
assert.match(freshPrompt, /默认用自然连贯的段落表达，不要自己起标题和列表/);
assert.match(freshPrompt, /current execution state, then whether the user is needed now or the work can stay parked/);
assert.match(freshPrompt, /multi-goal routing as a first-order judgment/);
assert.match(freshPrompt, /bounded work deserves bounded context/);

const resumedPrompt = await buildPrompt(
  'session-test-1',
  {
    ...baseSession,
    codexThreadId: 'thread-test-1',
  },
  '继续。',
  'codex',
  'codex',
  null,
  {},
);

assert.match(resumedPrompt, /<private>[\s\S]*Manager note: RemoteLab remains the manager for this turn/);
assert.match(resumedPrompt, /Current user message:/);
assert.doesNotMatch(resumedPrompt, /Memory System — Pointer-First Activation/);
assert.match(resumedPrompt, /Agent 更像执行器，Manager 负责统一任务语义和边界/);

const splitPrompt = await buildPrompt(
  'session-test-6',
  baseSession,
  `现在手上都有哪些任务，我觉得需要关注两点：
1. 现在都积压了哪些任务，我们看下接下来做什么
2. 我们的 TODO 记录是标准流程吗，需不需要做一个定型？`,
  'codex',
  'codex',
  null,
  { skipSessionContinuation: true },
);

assert.match(splitPrompt, /Routing principle for this turn/);
assert.match(splitPrompt, /Bounded work should prefer bounded context/);
assert.match(splitPrompt, /Prefer splitting them into child sessions/);
assert.match(splitPrompt, /1\. 现在都积压了哪些任务，我们看下接下来做什么/);
assert.match(splitPrompt, /2\. 我们的 TODO 记录是标准流程吗，需不需要做一个定型/);

const feishuSourcePrompt = await buildPrompt(
  'session-test-3',
  {
    ...baseSession,
    sourceId: 'feishu',
    sourceName: 'Feishu',
  },
  '帮我看一下这个仓库的问题。',
  'codex',
  'codex',
  null,
  { skipSessionContinuation: true },
);

assert.match(feishuSourcePrompt, /Source\/runtime instructions \(backend-owned for this session source\):/);
assert.match(feishuSourcePrompt, /same RemoteLab executor you would be in ChatUI/);
assert.match(feishuSourcePrompt, /Do not collapse action requests into a one-line acknowledgement/);

const observerSourcePrompt = await buildPrompt(
  'session-test-4',
  {
    ...baseSession,
    sourceId: 'observer',
    sourceName: 'Home Coach',
  },
  'Current task:\nWelcome the user home.',
  'codex',
  'codex',
  null,
  { skipSessionContinuation: true },
);

assert.match(observerSourcePrompt, /Output only the text that should be spoken aloud through the speaker/);

const githubSourcePrompt = await buildPrompt(
  'session-test-5',
  {
    ...baseSession,
    sourceId: 'github',
    sourceName: 'GitHub',
  },
  'Source: GitHub\n\nUser message:\nPlease inspect the failure.',
  'codex',
  'codex',
  null,
  { skipSessionContinuation: true },
);

assert.match(githubSourcePrompt, /Produce plain text or markdown suitable for posting back through GitHub/);

const microAgentPrompt = await buildPrompt(
  'session-test-2',
  baseSession,
  '看一下这个项目的背景。',
  'micro-agent',
  'micro-agent',
  null,
  { skipSessionContinuation: true },
);

assert.match(microAgentPrompt, /<private>[\s\S]*Manager note: RemoteLab remains the manager for this turn/);
assert.match(microAgentPrompt, /User message:/);
assert.match(microAgentPrompt, /Memory System — Pointer-First Activation/);

console.log('test-session-manager-build-prompt: ok');
