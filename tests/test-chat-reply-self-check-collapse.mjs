#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const uiSource = readFileSync(join(repoRoot, 'static', 'chat', 'ui.js'), 'utf8');

function extractFunctionSource(source, functionName) {
  const marker = `function ${functionName}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${functionName} should exist in ui.js`);
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

function makeElement(tagName = 'div') {
  const element = {
    tagName,
    className: '',
    textContent: '',
    dataset: {},
    children: [],
    parentNode: null,
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
  };

  Object.defineProperty(element, 'lastElementChild', {
    get() {
      return this.children[this.children.length - 1] || null;
    },
  });

  return element;
}

const isReplySelfCheckStatusEventSource = extractFunctionSource(uiSource, 'isReplySelfCheckStatusEvent');
const isReplySelfCheckOperationEventSource = extractFunctionSource(uiSource, 'isReplySelfCheckOperationEvent');
const getContainerLastElementSource = extractFunctionSource(uiSource, 'getContainerLastElement');
const getOrCreateReplySelfCheckDrawerSource = extractFunctionSource(uiSource, 'getOrCreateReplySelfCheckDrawer');
const renderStatusIntoSource = extractFunctionSource(uiSource, 'renderStatusInto');
const humanizeContextOperationValueSource = extractFunctionSource(uiSource, 'humanizeContextOperationValue');
const renderContextOperationIntoSource = extractFunctionSource(uiSource, 'renderContextOperationInto');

const context = {
  console,
  WeakMap,
  document: {
    createElement(tagName) {
      return makeElement(tagName);
    },
  },
  t(key) {
    if (key === 'replySelfCheck.drawerSummary') return 'Background reply review';
    if (key === 'context.barrier') return 'Older messages above this marker are no longer in the current context.';
    return key;
  },
};
context.globalThis = context;

vm.runInNewContext(
  [
    'const replySelfCheckDrawerByContainer = new WeakMap();',
    isReplySelfCheckStatusEventSource,
    isReplySelfCheckOperationEventSource,
    getContainerLastElementSource,
    getOrCreateReplySelfCheckDrawerSource,
    renderStatusIntoSource,
    humanizeContextOperationValueSource,
    renderContextOperationIntoSource,
    'globalThis.renderStatusInto = renderStatusInto;',
    'globalThis.renderContextOperationInto = renderContextOperationInto;',
  ].join('\n\n'),
  context,
  { filename: 'static/chat/ui.js' },
);

const container = makeElement('section');

context.renderStatusInto(container, {
  type: 'status',
  content: 'Assistant self-check: reviewing the latest reply for early stop…',
});

assert.equal(container.children.length, 1, 'reply self-check status should create a single collapsed drawer');
const firstDrawer = container.children[0];
assert.equal(firstDrawer.tagName, 'details', 'reply self-check events should render inside a details drawer');
assert.equal(firstDrawer.className, 'turn-collapse-drawer reply-self-check-drawer');
assert.equal(firstDrawer.children[0].textContent, 'Background reply review', 'drawer summary should use the background review label');
assert.equal(firstDrawer.children[1].children.length, 1, 'drawer body should receive the hidden self-check status');
assert.equal(firstDrawer.children[1].children[0].className, 'msg-system');

context.renderContextOperationInto(container, {
  type: 'context_operation',
  operation: 'continue_turn',
  trigger: 'automatic',
  phase: 'queued',
  title: 'Automatic continuation reviewing',
  summary: 'RemoteLab is checking whether the latest reply stopped too early.',
});

assert.equal(container.children.length, 1, 'consecutive reply self-check events should reuse the same drawer');
assert.equal(firstDrawer.children[1].children.length, 2, 'drawer body should append the automatic continuation card');
assert.equal(firstDrawer.children[1].children[1].className, 'context-operation');

context.renderStatusInto(container, {
  type: 'status',
  content: 'Preparing environment',
});

assert.equal(container.children.length, 2, 'normal statuses should still render outside the drawer');
assert.equal(container.children[1].className, 'msg-system');

context.renderStatusInto(container, {
  type: 'status',
  content: 'Assistant self-check: kept the latest reply as-is.',
});

assert.equal(container.children.length, 3, 'a later self-check after normal output should start a new drawer');
const secondDrawer = container.children[2];
assert.notEqual(secondDrawer, firstDrawer, 'later self-check events should not reuse an older closed drawer');
assert.equal(secondDrawer.className, 'turn-collapse-drawer reply-self-check-drawer');
assert.equal(secondDrawer.children[1].children.length, 1, 'the later self-check drawer should contain its own status');

console.log('test-chat-reply-self-check-collapse: ok');
