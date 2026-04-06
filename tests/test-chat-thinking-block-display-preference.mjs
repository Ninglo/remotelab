#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const bootstrapSource = readFileSync(join(repoRoot, 'static', 'chat', 'bootstrap.js'), 'utf8');
const sessionHttpHelpersSource = readFileSync(join(repoRoot, 'static', 'chat', 'session-http-helpers.js'), 'utf8');
const uiSource = readFileSync(join(repoRoot, 'static', 'chat', 'ui.js'), 'utf8');

function extractFunctionSource(source, functionName) {
  const marker = `function ${functionName}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${functionName} should exist`);
  const paramsStart = source.indexOf('(', start);
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

const normalizeThinkingBlockDisplayModeSource = extractFunctionSource(bootstrapSource, 'normalizeThinkingBlockDisplayMode');
const getThinkingBlockDisplayExpandedStateSource = extractFunctionSource(bootstrapSource, 'getThinkingBlockDisplayExpandedState');
const shouldExpandThinkingBlocksByDefaultForSessionUiSource = extractFunctionSource(sessionHttpHelpersSource, 'shouldExpandThinkingBlocksByDefaultForSessionUi');
const resetRenderedEventStateSource = extractFunctionSource(sessionHttpHelpersSource, 'resetRenderedEventState');
const shouldOpenThinkingBlocksFromPreferenceSource = extractFunctionSource(uiSource, 'shouldOpenThinkingBlocksFromPreference');
const renderThinkingBlockEventSource = extractFunctionSource(uiSource, 'renderThinkingBlockEvent');

const bootstrapContext = {
  console,
  currentThinkingBlockDisplayMode: 'collapsed',
};
bootstrapContext.globalThis = bootstrapContext;

vm.runInNewContext(
  [
    normalizeThinkingBlockDisplayModeSource,
    getThinkingBlockDisplayExpandedStateSource,
    'globalThis.normalizeThinkingBlockDisplayMode = normalizeThinkingBlockDisplayMode;',
    'globalThis.getThinkingBlockDisplayExpandedState = getThinkingBlockDisplayExpandedState;',
  ].join('\n\n'),
  bootstrapContext,
  { filename: 'static/chat/bootstrap.js' },
);

assert.equal(
  bootstrapContext.normalizeThinkingBlockDisplayMode('collapsed'),
  'collapsed',
  'collapsed should remain a valid explicit thinking block preference',
);
assert.equal(
  bootstrapContext.normalizeThinkingBlockDisplayMode('anything-else'),
  'collapsed',
  'invalid stored preferences should fall back to collapsed',
);
assert.equal(
  bootstrapContext.getThinkingBlockDisplayExpandedState(),
  false,
  'collapsed mode should keep thinking blocks closed by default',
);
bootstrapContext.currentThinkingBlockDisplayMode = 'expanded';
assert.equal(
  bootstrapContext.getThinkingBlockDisplayExpandedState(),
  true,
  'expanded mode should open thinking blocks by default',
);

const sessionHelperContext = {
  console,
  window: {
    remotelabShouldExpandThinkingBlocksByDefault() {
      return false;
    },
  },
  renderedEventState: {
    sessionId: null,
    latestSeq: 17,
    eventCount: 3,
    eventBaseKeys: ['1:message'],
    eventKeys: ['1:message'],
    runState: 'running',
    runningBlockExpanded: false,
  },
};
sessionHelperContext.globalThis = sessionHelperContext;

vm.runInNewContext(
  [
    shouldExpandThinkingBlocksByDefaultForSessionUiSource,
    resetRenderedEventStateSource,
    'globalThis.resetRenderedEventState = resetRenderedEventState;',
  ].join('\n\n'),
  sessionHelperContext,
  { filename: 'static/chat/session-http-helpers.js' },
);

sessionHelperContext.resetRenderedEventState('session-collapsed');
assert.equal(
  sessionHelperContext.renderedEventState.runningBlockExpanded,
  false,
  'resetting rendered event state should seed running block expansion from the default preference (collapsed)',
);
sessionHelperContext.window.remotelabShouldExpandThinkingBlocksByDefault = () => true;
sessionHelperContext.resetRenderedEventState('session-expanded');
assert.equal(
  sessionHelperContext.renderedEventState.runningBlockExpanded,
  true,
  'resetting rendered event state should honor expanded mode when explicitly set',
);

function createClassList(initialTokens = []) {
  const tokens = new Set(initialTokens);
  return {
    add(...items) {
      items.forEach((item) => tokens.add(item));
    },
    remove(...items) {
      items.forEach((item) => tokens.delete(item));
    },
    toggle(item) {
      if (tokens.has(item)) {
        tokens.delete(item);
        return false;
      }
      tokens.add(item);
      return true;
    },
    contains(item) {
      return tokens.has(item);
    },
  };
}

function createThinkingBlock(collapsed) {
  const label = { textContent: '' };
  const body = { dataset: {} };
  const block = {
    dataset: {},
    classList: createClassList(collapsed ? ['thinking-block', 'collapsed'] : ['thinking-block']),
    querySelector(selector) {
      if (selector === '.thinking-label') return label;
      if (selector === '.thinking-body') return body;
      return null;
    },
  };
  const header = {
    addEventListener() {},
  };
  return { block, body, header, label };
}

let createdThinkingBlocks = [];
let eventBlockLoads = [];
let runningBlockStateUpdates = [];

const uiContext = {
  console,
  window: {
    remotelabShouldExpandThinkingBlocksByDefault() {
      return false;
    },
  },
  Number,
  inThinkingBlock: false,
  currentSessionId: 'session_1',
  renderedEventState: {
    runningBlockExpanded: false,
  },
  finalizeThinkingBlock() {},
  isRunningThinkingBlockEvent(evt) {
    return evt?.state === 'running';
  },
  getThinkingBlockLabel() {
    return 'Thought';
  },
  createDeferredThinkingBlock(label, { collapsed = true } = {}) {
    const thinking = createThinkingBlock(collapsed);
    thinking.label.textContent = label;
    createdThinkingBlocks.push(thinking);
    return thinking;
  },
  setRunningEventBlockExpanded(sessionId, expanded) {
    runningBlockStateUpdates.push({ sessionId, expanded });
  },
  ensureEventBlockLoaded(sessionId, body, evt) {
    eventBlockLoads.push({ sessionId, body, seq: evt?.seq || 0 });
    return Promise.resolve();
  },
  refreshCurrentSession() {
    return Promise.resolve();
  },
  messagesInner: {
    children: [],
    appendChild(node) {
      this.children.push(node);
      return node;
    },
  },
};
uiContext.globalThis = uiContext;

vm.runInNewContext(
  [
    shouldOpenThinkingBlocksFromPreferenceSource,
    renderThinkingBlockEventSource,
    'globalThis.renderThinkingBlockEvent = renderThinkingBlockEvent;',
  ].join('\n\n'),
  uiContext,
  { filename: 'static/chat/ui.js' },
);

uiContext.renderThinkingBlockEvent({
  seq: 5,
  state: 'completed',
  blockStartSeq: 5,
  blockEndSeq: 8,
});
assert.equal(
  createdThinkingBlocks[0]?.block.classList.contains('collapsed'),
  true,
  'completed thinking blocks should stay collapsed when the default preference is collapsed',
);
assert.equal(
  eventBlockLoads.length,
  0,
  'collapsed-by-default completed thinking blocks should avoid eager hidden-body fetches',
);

createdThinkingBlocks = [];
eventBlockLoads = [];
uiContext.messagesInner.children = [];
uiContext.window.remotelabShouldExpandThinkingBlocksByDefault = () => true;
uiContext.renderThinkingBlockEvent({
  seq: 9,
  state: 'completed',
  blockStartSeq: 9,
  blockEndSeq: 10,
});
assert.equal(
  createdThinkingBlocks[0]?.block.classList.contains('collapsed'),
  false,
  'completed thinking blocks should open when the user preference is expanded',
);
assert.equal(
  eventBlockLoads.length,
  1,
  'expanded completed thinking blocks should fetch their hidden body immediately',
);

createdThinkingBlocks = [];
eventBlockLoads = [];
runningBlockStateUpdates = [];
uiContext.messagesInner.children = [];
uiContext.window.remotelabShouldExpandThinkingBlocksByDefault = () => false;
uiContext.renderedEventState.runningBlockExpanded = false;
uiContext.renderThinkingBlockEvent({
  seq: 12,
  state: 'running',
  blockStartSeq: 12,
  blockEndSeq: 14,
});
assert.equal(
  createdThinkingBlocks[0]?.block.classList.contains('collapsed'),
  true,
  'running thinking blocks should keep the current per-run expansion state instead of blindly reopening',
);
assert.deepEqual(
  runningBlockStateUpdates,
  [{ sessionId: 'session_1', expanded: false }],
  'running block state sync should preserve the effective per-run expansion state',
);

console.log('test-chat-thinking-block-display-preference: ok');
