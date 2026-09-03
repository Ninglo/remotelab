#!/usr/bin/env node
import assert from 'assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'remotelab-turn-hook-'));
process.env.HOME = tempHome;

const { buildTurnContextHook } = await import('../chat/turn-context-hook.mjs');

const hook = await buildTurnContextHook({
  activeAgreements: [
    '默认自然段表达。',
    '默认自然段表达。',
  ],
  workSummary: {
    mode: 'project',
    summary: '先消化用户给的材料，再推进下一步。',
    rawMaterials: ['sales.xlsx'],
    reusablePatterns: ['先接住具体材料，再决定是否把经验抽象成通用规则。'],
    nextSteps: ['检查结构'],
  },
});

assert.match(hook, /RemoteLab context pointers/);
assert.match(hook, /Bootstrap: .*\/memory\/bootstrap\.md/);
assert.match(hook, /Projects: .*\/memory\/projects\.md/);
assert.match(hook, /Memory writeback targets: .*\/memory\/writeback-targets\.json/);
assert.match(hook, /Auto user memory: .*\/memory\/model-context\/auto-user-memory\.md/);
assert.match(hook, /Auto system memory: (?:.*\/memory|\[platform-shared-memory\])\/auto-system-memory\.md/);
assert.match(hook, /Model context root: .*\/memory\/model-context/);
assert.match(hook, /active working agreements/);
assert.match(hook, /默认自然段表达。/);
assert.match(hook, /Current provider-neutral work summary/);
assert.match(hook, /Reusable patterns/);
assert.match(hook, /sales\.xlsx/);

assert.doesNotMatch(hook, /standing authorization/);
assert.doesNotMatch(hook, /Prefer RemoteLab-side execution/);
assert.doesNotMatch(hook, /brief self-review/);
assert.doesNotMatch(hook, /split into child sessions/);

console.log('test-turn-context-hook: ok');
