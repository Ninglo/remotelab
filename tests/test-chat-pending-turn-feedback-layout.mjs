#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const uiSource = readFileSync(join(repoRoot, 'static/chat/ui.js'), 'utf8');

function extractFunctionSource(source, functionName) {
  const marker = `function ${functionName}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${functionName} should exist`);
  const paramsStart = source.indexOf('(', start);
  assert.notEqual(paramsStart, -1, `${functionName} should have parameters`);
  let paramsDepth = 0;
  let braceStart = -1;
  for (let index = paramsStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') paramsDepth += 1;
    if (char === ')') {
      paramsDepth -= 1;
      if (paramsDepth === 0) {
        braceStart = source.indexOf('{', index);
        break;
      }
    }
  }
  assert.notEqual(braceStart, -1, `${functionName} should have a body`);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  throw new Error(`Unable to extract ${functionName}`);
}

const syncComposerPendingTurnFeedbackSource = extractFunctionSource(
  uiSource,
  'syncComposerPendingTurnFeedback',
);

function createContext({
  pendingSend = null,
  committedNode = null,
  localEchoNode = null,
} = {}) {
  const metrics = {
    preserveCalls: [],
    removeCalls: [],
    setStatusCalls: [],
    localEchoRemovals: 0,
    committedClassRemovals: [],
    bubbleClassRemovals: [],
    appendCalls: 0,
    scrollToBottomCalls: 0,
  };

  const context = {
    console,
    currentSessionId: 'session-a',
    messagesInner: {
      appendChild() {
        metrics.appendCalls += 1;
      },
    },
    emptyState: {
      parentNode: null,
      remove() {},
    },
    getComposerPendingSendSnapshot() {
      return pendingSend;
    },
    removeComposerPendingUserStatuses(options = {}) {
      metrics.removeCalls.push(options);
    },
    getComposerPendingInlineStatusText(stage) {
      return stage ? `status:${stage}` : '';
    },
    findCommittedUserMessageNode() {
      return committedNode;
    },
    findLocalEchoUserMessageNode() {
      return localEchoNode;
    },
    setUserMessageStatus(node, text, stage) {
      metrics.setStatusCalls.push({ node, text, stage });
    },
    createUserMessageNode() {
      return {
        classList: { remove() {} },
        querySelector() {
          return { classList: { remove() {} } };
        },
      };
    },
    scrollToBottom() {
      metrics.scrollToBottomCalls += 1;
    },
    window: {
      RemoteLabLayout: {
        preserveBottomPinnedMessageViewport(mutator, options = {}) {
          metrics.preserveCalls.push(options);
          return mutator();
        },
      },
    },
    Date,
  };
  context.globalThis = context;
  context.__metrics = metrics;
  return context;
}

const committedNode = {
  classList: {
    remove(token) {
      committedContext.__metrics.committedClassRemovals.push(token);
    },
  },
  querySelector(selector) {
    assert.equal(selector, '.msg-user-bubble');
    return {
      classList: {
        remove(token) {
          committedContext.__metrics.bubbleClassRemovals.push(token);
        },
      },
    };
  },
};

const localEchoNode = {
  remove() {
    committedContext.__metrics.localEchoRemovals += 1;
  },
};

const committedContext = createContext({
  pendingSend: {
    sessionId: 'session-a',
    requestId: 'req-1',
    stage: 'checking',
    text: 'hello',
    images: [],
  },
  committedNode,
  localEchoNode,
});

vm.runInNewContext(
  `${syncComposerPendingTurnFeedbackSource}\nglobalThis.syncComposerPendingTurnFeedback = syncComposerPendingTurnFeedback;`,
  committedContext,
  { filename: 'static/chat/ui.js' },
);

committedContext.syncComposerPendingTurnFeedback();

assert.equal(committedContext.__metrics.preserveCalls.length, 1, 'pending-turn sync should route committed-message status updates through the shared bottom-pinning helper');
assert.equal(committedContext.__metrics.preserveCalls[0]?.reason, 'composer-pending-turn-feedback', 'pending-turn sync should label the bottom-pinning layout reason');
assert.equal(committedContext.__metrics.removeCalls.length, 1, 'pending-turn sync should still clear stale inline statuses before updating the active request');
assert.equal(committedContext.__metrics.removeCalls[0]?.keepRequestId, 'req-1', 'pending-turn sync should keep the active request while clearing stale inline statuses');
assert.equal(committedContext.__metrics.localEchoRemovals, 1, 'pending-turn sync should still remove the local echo once the committed user turn exists');
assert.equal(committedContext.__metrics.setStatusCalls.length, 1, 'pending-turn sync should still refresh the committed user-turn status label');
assert.equal(committedContext.__metrics.committedClassRemovals[0], 'msg-user-local-echo', 'pending-turn sync should clear the transient local-echo marker from the committed node');
assert.equal(committedContext.__metrics.bubbleClassRemovals[0], 'msg-pending', 'pending-turn sync should clear the transient pending bubble styling once the committed node exists');

const clearedContext = createContext({
  pendingSend: null,
});

vm.runInNewContext(
  `${syncComposerPendingTurnFeedbackSource}\nglobalThis.syncComposerPendingTurnFeedback = syncComposerPendingTurnFeedback;`,
  clearedContext,
  { filename: 'static/chat/ui.js' },
);

clearedContext.syncComposerPendingTurnFeedback();

assert.equal(clearedContext.__metrics.preserveCalls.length, 1, 'pending-turn sync should preserve a bottom-pinned viewport even when it only clears stale inline statuses');
assert.equal(clearedContext.__metrics.removeCalls.length, 1, 'pending-turn sync should still clear stale inline statuses when no pending send remains');
assert.equal(Object.keys(clearedContext.__metrics.removeCalls[0] || {}).length, 0, 'pending-turn sync should clear stale inline statuses without pinning a specific request once the pending send is gone');

console.log('test-chat-pending-turn-feedback-layout: ok');
