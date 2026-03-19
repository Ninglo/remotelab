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
