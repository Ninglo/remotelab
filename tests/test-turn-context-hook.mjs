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
  taskCard: {
    mode: 'project',
    summary: '先消化用户给的材料，再推进下一步。',
    rawMaterials: ['sales.xlsx'],
    reusablePatterns: ['先接住具体材料，再决定是否把经验抽象成通用规则。'],
    nextSteps: ['检查结构'],
  },
});

assert.match(hook, /lightweight external context hook/);
assert.match(hook, /Stable context entry points:/);
assert.match(hook, /Bootstrap: ~\/\.remotelab\/memory\/bootstrap\.md/);
assert.match(hook, /Projects: ~\/\.remotelab\/memory\/projects\.md/);
assert.match(hook, /Model-managed writable context root:/);
assert.match(hook, /~\/\.remotelab\/memory\/model-context/);
assert.match(hook, /local skill, wrapper, note, or prior pattern already fits/);
assert.match(hook, /split into child sessions or scratch notes when that reduces noise/);
assert.match(hook, /did you use the best available path, is the result complete for the user/);
assert.match(hook, /active working agreements/);
assert.match(hook, /默认自然段表达。/);
assert.match(hook, /Current carried task card/);
assert.match(hook, /Reusable patterns/);
assert.match(hook, /sales\.xlsx/);

console.log('test-turn-context-hook: ok');
