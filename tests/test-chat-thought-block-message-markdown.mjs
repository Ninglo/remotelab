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
  return {
    tagName: String(tagName || 'div').toUpperCase(),
    className: '',
    textContent: '',
    innerHTML: '',
    dataset: {},
    children: [],
    appendChild(child) {
      this.children.push(child);
      return child;
    },
  };
}

const renderMessageIntoSource = extractFunctionSource(uiSource, 'renderMessageInto');
const markdownCalls = [];
const timestampCalls = [];

const context = {
  console,
  document: {
    createElement(tagName) {
      return makeElement(tagName);
    },
  },
  renderMarkdownIntoNode(node, markdown) {
    markdownCalls.push({ node, markdown });
    node.innerHTML = `<p>${markdown}</p>`;
    return true;
  },
  appendMessageTimestamp(node, stamp, extraClass = '') {
    timestampCalls.push({ node, stamp, extraClass });
  },
  markLazyEventBodyNode() {
    return false;
  },
  queueHydrateLazyNodes() {},
  formatDecodedDisplayText(value) {
    return typeof value === 'string' ? value : '';
  },
  createMessageAttachmentNode() {
    return null;
  },
  inThinkingBlock: false,
  finalizeThinkingBlock() {
    context.finalizedThinkingBlock = true;
  },
};
context.globalThis = context;

vm.runInNewContext(
  [
    renderMessageIntoSource,
    'globalThis.renderMessageInto = renderMessageInto;',
  ].join('\n\n'),
  context,
  { filename: 'static/chat/ui.js' },
);

const container = makeElement('div');
const assistantMessage = {
  role: 'assistant',
  content: 'Before final answer:\n\n- item **one**\n- item `two`',
  timestamp: '2026-03-17T10:00:00.000Z',
};

const node = context.renderMessageInto(container, assistantMessage);

assert.equal(container.children.length, 1, 'assistant message should append exactly one rendered node');
assert.equal(container.children[0], node, 'renderMessageInto should return the appended assistant node');
assert.equal(node.className, 'msg-assistant md-content', 'assistant messages should keep markdown-capable styling');
assert.equal(node.children.length, 1, 'assistant node should contain a dedicated body wrapper');
assert.equal(node.children[0].className, 'msg-assistant-body', 'assistant node should render into the assistant body wrapper');
assert.equal(markdownCalls.length, 1, 'assistant message rendering should invoke the markdown renderer');
assert.equal(markdownCalls[0].markdown, assistantMessage.content, 'assistant message rendering should pass the original message text into markdown');
assert.equal(timestampCalls.length, 1, 'assistant message rendering should still append timestamps');

console.log('test-chat-thought-block-message-markdown: ok');
