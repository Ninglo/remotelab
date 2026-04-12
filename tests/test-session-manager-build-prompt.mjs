#!/usr/bin/env node
import assert from 'assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'remotelab-build-prompt-'));
process.env.HOME = tempHome;
process.env.REMOTELAB_PUBLIC_BASE_URL = '';

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
    {
      id: 'micro-agent-custom',
      name: 'Micro Agent Custom',
      toolProfile: 'micro-agent',
      command: 'micro-agent-router.mjs',
      runtimeFamily: 'claude-stream-json',
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

assert.match(freshPrompt, /<private>[\s\S]*lightweight external context hook/);
assert.match(freshPrompt, /User message:/);
assert.match(freshPrompt, /do not mirror its headings, bullets, or checklist structure back to the user/);
assert.match(freshPrompt, /active working agreements/);
assert.match(freshPrompt, /默认用自然连贯的段落表达，不要自己起标题和列表/);
assert.match(freshPrompt, /Stable context entry points:/);
assert.match(freshPrompt, /Projects: ~\/\.remotelab\/memory\/projects\.md/);
assert.match(freshPrompt, /Memory writeback targets config: ~\/\.remotelab\/memory\/writeback-targets\.json/);
assert.match(freshPrompt, /Auto user memory: ~\/\.remotelab\/memory\/model-context\/auto-user-memory\.md/);
assert.match(freshPrompt, /Auto system memory: \/opt\/remotelab\/memory\/auto-system-memory\.md/);
assert.match(freshPrompt, /Model-managed writable context root:/);
assert.match(freshPrompt, /~\/\.remotelab\/memory\/model-context/);
assert.match(freshPrompt, /execution substrate, not as the end user's personal Mac|Treat the host as execution substrate/);
assert.match(freshPrompt, /only use connectors and delivery channels that are explicitly configured|prefer instance-scoped connectors/);
assert.doesNotMatch(freshPrompt, /Subscription link \(webcal\): webcal:\/\/127\.0\.0\.1:/);
assert.doesNotMatch(freshPrompt, /Subscription link \(https\): http:\/\/127\.0\.0\.1:/);

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

assert.match(resumedPrompt, /<private>[\s\S]*lightweight external context hook/);
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

assert.match(splitPrompt, /lightweight external context hook/);
assert.match(splitPrompt, /Stable context entry points:/);
assert.doesNotMatch(splitPrompt, /Routing principle for this turn/);

const feishuSourcePrompt = await buildPrompt(
  'session-test-3',
  {
    ...baseSession,
    sourceId: 'feishu',
    sourceName: 'Feishu',
    sourceContext: {
      chatType: 'group',
    },
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
assert.match(feishuSourcePrompt, /Do not include emoji characters, emoticons, or sticker aliases/);
assert.match(feishuSourcePrompt, /source-context/);
assert.match(feishuSourcePrompt, /This session maps to a group chat/);

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

assert.equal(microAgentPrompt, '看一下这个项目的背景。');

const promptWithTaskCard = await buildPrompt(
  'session-test-7',
  {
    ...baseSession,
    taskCard: {
      mode: 'project',
      summary: '先吃透用户丢来的 Excel 和 PPT，再决定如何组织项目态。',
      rawMaterials: ['sales.xlsx', 'deck.pptx'],
      reusablePatterns: ['先接住原始材料，再决定是否把经验抽象成流程。'],
      nextSteps: ['检查材料结构', '整理第一版任务摘要'],
      memory: ['用户偏好直接给原始材料，不想先写长说明。'],
    },
  },
  '继续推进。',
  'codex',
  'codex',
  null,
  { skipSessionContinuation: true },
);

assert.match(promptWithTaskCard, /Current carried task card/);
assert.match(promptWithTaskCard, /Execution mode: project/);
assert.match(promptWithTaskCard, /sales\.xlsx/);
assert.match(promptWithTaskCard, /Reusable patterns/);
assert.match(promptWithTaskCard, /Durable user memory/);

const welcomePrompt = await buildPrompt(
  'session-test-8',
  {
    ...baseSession,
    starterPreset: 'welcome',
    systemPrompt: 'WELCOME SYSTEM PROMPT',
  },
  '先帮我接住这个需求。',
  'codex',
  'codex',
  null,
  { skipSessionContinuation: true },
);

assert.match(welcomePrompt, /WELCOME SYSTEM PROMPT/);

const retiredWelcomePrompt = await buildPrompt(
  'session-test-9',
  {
    ...baseSession,
    starterPreset: 'welcome',
    systemPrompt: 'WELCOME SYSTEM PROMPT',
    welcomeOnboardingRetiredAt: '2025-01-01T00:00:00.000Z',
  },
  '继续执行。',
  'codex',
  'codex',
  null,
  { skipSessionContinuation: true },
);

assert.doesNotMatch(retiredWelcomePrompt, /WELCOME SYSTEM PROMPT/);

// --- Regression: bare-user micro-agent with claude-stream-json should include continuation context ---

const { setForkContext } = await import('../chat/history.mjs');
await setForkContext('session-test-bare-user-cont', {
  mode: 'history',
  summary: '',
  continuationBody: '[User]\n记住 13 这个数\n\n[Assistant]\nGot it. 13.',
  activeFromSeq: 0,
  preparedThroughSeq: 0,
  source: 'history',
});

const bareUserContinuationPrompt = await buildPrompt(
  'session-test-bare-user-cont',
  baseSession,
  '刚才是啥',
  'micro-agent-custom',
  'micro-agent-custom',
  null,
  {},
);

assert.match(bareUserContinuationPrompt, /记住 13 这个数/, 'bare-user prompt must include continuation history');
assert.match(bareUserContinuationPrompt, /Got it\. 13\./, 'bare-user prompt must include assistant reply from history');
assert.match(bareUserContinuationPrompt, /刚才是啥/, 'bare-user prompt must include current user message');

console.log('test-session-manager-build-prompt: ok');
