#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import vm from 'node:vm';

const source = await readFile(join(process.cwd(), 'static/chat/ui.js'), 'utf8');
const start = source.indexOf('function createUserMessageNode(');
const end = source.indexOf('\nfunction syncComposerPendingTurnFeedback()', start);
assert.ok(start >= 0 && end > start);

function element() {
  return {
    children: [], dataset: {}, className: '', textContent: '',
    appendChild(child) { this.children.push(child); return child; },
    classList: { add() {} },
  };
}

const context = {
  document: { createElement: element },
  formatDecodedDisplayText: value => value,
  markLazyEventBodyNode: () => false,
  appendMessageTimestamp() {},
};
context.globalThis = context;
vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.createUserMessageNode = createUserMessageNode;`, context);

const oldGroupMessage = {
  content: '这件事还没决定',
  sourceContext: { connector: 'feishu', chatType: 'group',
    sender: { name: '张三', openId: 'ou_original_123456' } },
};
const oldBubble = context.createUserMessageNode(oldGroupMessage).children[0];
assert.equal(oldBubble.children[0].textContent, '张三 · 身份尾号 123456',
  'old Feishu group history should show the persisted sender metadata');

const alreadyAttributed = context.createUserMessageNode({
  ...oldGroupMessage, content: '【飞书群消息｜发言人：张三（成员 1234567890）】\n这件事还没决定',
}).children[0];
assert.equal(alreadyAttributed.children.length, 1,
  'new group messages already carry their author in the transcript body');

const privateBubble = context.createUserMessageNode({
  ...oldGroupMessage, sourceContext: { ...oldGroupMessage.sourceContext, chatType: 'p2p' },
}).children[0];
assert.equal(privateBubble.children.length, 1, 'private conversations should keep their existing display');

console.log('Feishu group transcript displays old sender metadata without duplicating new labels');
