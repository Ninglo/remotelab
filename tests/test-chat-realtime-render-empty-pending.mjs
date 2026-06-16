#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const realtimeRenderSource = readFileSync(join(repoRoot, 'static/chat/realtime-render.js'), 'utf8');

function sliceBetween(source, startToken, endToken) {
  const start = source.indexOf(startToken);
  if (start === -1) {
    throw new Error(`Missing start token: ${startToken}`);
  }
  const end = source.indexOf(endToken, start);
  if (end === -1) {
    throw new Error(`Missing end token: ${endToken}`);
  }
  return source.slice(start, end);
}

const showEmptySnippet = sliceBetween(
  realtimeRenderSource,
  'function showEmpty()',
  'function scrollToBottom()',
);

const messagesInner = {
  innerHTML: 'existing',
  appended: [],
  appendChild(node) {
    node.parentNode = this;
    this.appended.push(node);
  },
};

const emptyState = { id: 'empty', parentNode: null };
let queuedPanelArg = 'unset';
let templateSyncs = 0;
let pendingSyncs = 0;
let forkSyncs = 0;
let shareSyncs = 0;

const context = {
  messagesInner,
  emptyState,
  inThinkingBlock: true,
  currentThinkingBlock: { stale: true },
  renderQueuedMessagePanel(session) {
    queuedPanelArg = session;
  },
  syncSessionTemplateControls() {
    templateSyncs += 1;
  },
  syncComposerPendingTurnFeedback() {
    pendingSyncs += 1;
  },
  syncForkButton() {
    forkSyncs += 1;
  },
  syncShareButton() {
    shareSyncs += 1;
  },
};
context.globalThis = context;

vm.runInNewContext(showEmptySnippet, context, {
  filename: 'chat-realtime-render-empty-pending-runtime.js',
});

context.showEmpty();

assert.equal(messagesInner.innerHTML, '', 'showEmpty should clear the rendered transcript container');
assert.equal(messagesInner.appended[0], emptyState, 'showEmpty should append the empty-state node');
assert.equal(queuedPanelArg, null, 'showEmpty should clear the queued-message panel');
assert.equal(templateSyncs, 1, 'showEmpty should refresh template controls');
assert.equal(pendingSyncs, 1, 'showEmpty should resync pending composer echoes after clearing the transcript');
assert.equal(forkSyncs, 1, 'showEmpty should refresh fork affordances');
assert.equal(shareSyncs, 1, 'showEmpty should refresh share affordances');
assert.equal(context.inThinkingBlock, false, 'showEmpty should reset the active thinking-block state');
assert.equal(context.currentThinkingBlock, null, 'showEmpty should drop the active thinking-block reference');

console.log('test-chat-realtime-render-empty-pending: ok');
