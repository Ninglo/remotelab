#!/usr/bin/env node
import assert from 'assert/strict';

import {
  buildTaskCardPromptBlock,
  normalizeSessionTaskCard,
  parseTaskCardFromAssistantContent,
} from '../chat/session-task-card.mjs';

const normalized = normalizeSessionTaskCard({
  mode: 'project',
  summary: '整理销售周报的 Excel 和 PPT，并产出一版可复用流程。',
  goal: '把手工周报整理流程交给 RemoteLab 处理。',
  background: ['用户每周都要重复整理一次。'],
  rawMaterials: ['sales-weekly.xlsx', 'review-deck.pptx', '截图 2 张'],
  assumptions: ['本周先做一版样例。'],
  knownConclusions: ['原始材料比口头描述更关键。'],
  reusablePatterns: ['先吃透原始材料，再决定是否要把流程升格。'],
  nextSteps: ['先检查 Excel 和 PPT 的结构', '整理出最小可交付版本'],
  memory: ['用户偏好先看样例再决定是否固化流程。'],
  needsFromUser: ['如果字段含义不清，再补一个示例输出。'],
});

assert.equal(normalized?.mode, 'project');
assert.deepEqual(normalized?.rawMaterials, ['sales-weekly.xlsx', 'review-deck.pptx', '截图 2 张']);
assert.deepEqual(normalized?.reusablePatterns, ['先吃透原始材料，再决定是否要把流程升格。']);

const parsed = parseTaskCardFromAssistantContent([
  '先看材料，我已经开始整理。',
  '<private>',
  '<task_card>{',
  '  "mode": "task",',
  '  "summary": "先做一版轻量整理，再决定是否进入项目态。",',
  '  "rawMaterials": ["weekly.xlsx", "ops.pptx"],',
  '  "reusablePatterns": ["先接住材料，再决定是否抽象成长期流程"],',
  '  "nextSteps": ["检查字段", "给出样例输出"],',
  '  "memory": ["用户一般直接给原始材料，不喜欢先写长说明"]',
  '}</task_card>',
  '</private>',
].join('\n'));

assert.equal(parsed?.mode, 'task');
assert.equal(parsed?.summary, '先做一版轻量整理，再决定是否进入项目态。');
assert.deepEqual(parsed?.nextSteps, ['检查字段', '给出样例输出']);
assert.deepEqual(parsed?.reusablePatterns, ['先接住材料，再决定是否抽象成长期流程']);

const promptBlock = buildTaskCardPromptBlock(parsed);
assert.match(promptBlock, /Current carried task card/);
assert.match(promptBlock, /Execution mode: task/);
assert.match(promptBlock, /Raw materials:/);
assert.match(promptBlock, /Reusable patterns:/);
assert.match(promptBlock, /weekly\.xlsx/);
assert.match(promptBlock, /Durable user memory:/);

const inferredProject = normalizeSessionTaskCard({
  summary: '材料较多，需要拆步骤推进。',
  rawMaterials: ['a.xlsx', 'b.xlsx', 'c.pptx'],
  nextSteps: ['检查原始材料', '整理结构'],
});

assert.equal(inferredProject?.mode, 'project');

console.log('test-session-task-card: ok');
