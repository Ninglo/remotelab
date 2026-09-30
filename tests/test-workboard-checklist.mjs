import assert from 'node:assert/strict';
import test from 'node:test';
import { draftWorkboardChecklist } from '../lib/workboard-checklist.mjs';

test('explicit goal and acceptance lines become a checklist without model generation', () => {
  assert.equal(draftWorkboardChecklist('目标：核对交付。\n[ ] 文案 — 提供修订稿。\n[ ] 链接 — 每条可打开。'),
    '目标：核对交付。\n[ ] 文案 — 提供修订稿。\n[ ] 链接 — 每条可打开。');
});

test('ambiguous or incomplete requests remain with the Harness', () => {
  assert.equal(draftWorkboardChecklist('请完成文案和链接检查'), '');
  assert.equal(draftWorkboardChecklist('目标：完成工作\n[ ] 文案 — 提供修订稿。\n[ ] 链接'), '');
  assert.equal(draftWorkboardChecklist('目标：完成工作\n[ ] 唯一任务 — 可检查。'), '');
  assert.equal(draftWorkboardChecklist('目标：完成工作\n[x] 旧任务 — 已完成。\n[ ] 新任务 — 可检查。'), '');
});
