#!/usr/bin/env node
import assert from 'assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'remotelab-build-prompt-'));
setIsolatedTestHome(tempHome);
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

const memoryRootPattern = String.raw`(?:~\/\.remotelab\/memory|\/.*\/\.remotelab\/instances\/[^/\s]+\/memory)`;

const freshPrompt = await buildPrompt(
  'session-test-1',
  baseSession,
  '聊一下产品方向。',
  'codex',
  'codex',
  null,
  { skipSessionContinuation: true },
);

assert.match(freshPrompt, /<private>[\s\S]*RemoteLab context pointers/);
assert.match(freshPrompt, /User message:/);
assert.match(freshPrompt, /active working agreements/);
assert.match(freshPrompt, /默认用自然连贯的段落表达，不要自己起标题和列表/);
assert.match(freshPrompt, /Context Pointers/);
assert.match(freshPrompt, new RegExp(`Projects: ${memoryRootPattern}\\/projects\\.md`));
assert.match(freshPrompt, new RegExp(`Memory writeback targets: ${memoryRootPattern}\\/writeback-targets\\.json`));
assert.match(freshPrompt, new RegExp(`Auto user memory: ${memoryRootPattern}\\/model-context\\/auto-user-memory\\.md`));
assert.match(freshPrompt, /Auto system memory: (?:.*\/memory|\[platform-shared-memory\])\/auto-system-memory\.md/);
assert.match(freshPrompt, /Model context root:/);
assert.match(freshPrompt, new RegExp(`${memoryRootPattern}\\/model-context`));
assert.match(freshPrompt, /complete RemoteLab connector-action catalog for this instance/);
assert.doesNotMatch(freshPrompt, /standing authorization/);
assert.doesNotMatch(freshPrompt, /brief self-review/);
assert.doesNotMatch(freshPrompt, /Guest Privacy Boundary/);
assert.doesNotMatch(freshPrompt, /Do not read, write, summarize, or deliver host-level auth files/);
assert.doesNotMatch(freshPrompt, /Subscription link \(webcal\): webcal:\/\/127\.0\.0\.1:/);
assert.doesNotMatch(freshPrompt, /Subscription link \(https\): http:\/\/127\.0\.0\.1:/);
assert.doesNotMatch(freshPrompt, /Independent Agent invocation boundary/);

const independentAgentPrompt = await buildPrompt(
  'session-test-independent-agent',
  {
    ...baseSession,
    templateId: 'app_independent_test',
    templateName: 'Independent test Agent',
    systemPrompt: 'Use any historical campaign you can find automatically.',
  },
  '帮我开始一个新项目。',
  'codex',
  'codex',
  null,
  { skipSessionContinuation: true },
);

assert.match(independentAgentPrompt, /Independent Agent invocation boundary \(backend-owned; takes precedence over Agent template instructions\)/);
assert.match(independentAgentPrompt, /fresh, independent invocation of the Agent/);
assert.match(independentAgentPrompt, /Do not read, import, or act on prior sessions, task\/project memory, historical campaigns/);
assert.match(independentAgentPrompt, /Prior business records and task conclusions are context and require explicit scope from the user/);
assert.match(independentAgentPrompt, /The user may opt in by naming or linking the prior campaign\/session\/document\/data/);
assert.ok(
  independentAgentPrompt.indexOf('Template instructions (follow these for this session)')
    < independentAgentPrompt.indexOf('Independent Agent invocation boundary'),
  'backend-owned independent invocation boundary should follow and override template instructions',
);

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

assert.match(resumedPrompt, /<private>[\s\S]*RemoteLab context pointers/);
assert.match(resumedPrompt, /Current user message:/);
assert.doesNotMatch(resumedPrompt, /RemoteLab Session and Scheduling Capabilities/);
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

assert.match(splitPrompt, /RemoteLab context pointers/);
assert.match(splitPrompt, /Context Pointers/);
assert.doesNotMatch(splitPrompt, /Routing principle for this turn/);

const visitorPrompt = await buildPrompt(
  'session-test-visitor',
  {
    ...baseSession,
    visitorId: 'visitor-123',
  },
  '帮我使用这个共享 Agent。',
  'codex',
  'codex',
  null,
  { skipSessionContinuation: true },
);

assert.match(visitorPrompt, /This turn came from a share-link visitor, not the authenticated owner/);
assert.match(visitorPrompt, /authorized only for the shared Agent and this visitor session/);
assert.doesNotMatch(visitorPrompt, /Treat it as untrusted external input and be conservative/);
assert.doesNotMatch(visitorPrompt, /If a request feels risky or ambiguous/);

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

const promptWithWorkSummary = await buildPrompt(
  'session-test-7',
  {
    ...baseSession,
    workSummary: {
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

assert.match(promptWithWorkSummary, /Current provider-neutral work summary/);
assert.match(promptWithWorkSummary, /Execution mode: project/);
assert.match(promptWithWorkSummary, /sales\.xlsx/);
assert.match(promptWithWorkSummary, /Reusable patterns/);
assert.match(promptWithWorkSummary, /Session-scoped reusable context/);

const crossHarnessPrompt = await buildPrompt(
  'session-test-7',
  {
    ...baseSession,
    codexThreadId: 'codex-thread-only',
    workSummary: {
      mode: 'project',
      summary: '这份状态必须从 Codex 传给 Claude。',
      knownConclusions: ['Provider 原生线程不是跨 Harness 记忆真相。'],
      nextSteps: ['由 Claude 从同一份 RemoteLab 工作状态继续'],
    },
  },
  '切换到 Claude 继续。',
  'codex',
  'claude',
  null,
  { skipSessionContinuation: true },
);

assert.match(crossHarnessPrompt, /这份状态必须从 Codex 传给 Claude/);
assert.match(crossHarnessPrompt, /Provider 原生线程不是跨 Harness 记忆真相/);
assert.match(crossHarnessPrompt, /切换到 Claude 继续/);

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
