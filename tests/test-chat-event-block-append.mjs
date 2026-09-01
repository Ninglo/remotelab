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
  const functionStart = source.slice(Math.max(0, start - 6), start) === 'async '
    ? start - 6
    : start;
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
        return source.slice(functionStart, index + 1);
      }
    }
  }
  throw new Error(`Unable to extract ${functionName}`);
}

const parseEventBlockSeqSource = extractFunctionSource(uiSource, 'parseEventBlockSeq');
const getRenderedEventBlockStartSeqSource = extractFunctionSource(uiSource, 'getRenderedEventBlockStartSeq');
const getRenderedEventBlockEndSeqSource = extractFunctionSource(uiSource, 'getRenderedEventBlockEndSeq');
const setRenderedEventBlockRangeSource = extractFunctionSource(uiSource, 'setRenderedEventBlockRange');
const hasRenderedEventBlockContentSource = extractFunctionSource(uiSource, 'hasRenderedEventBlockContent');
const shouldAppendEventBlockContentSource = extractFunctionSource(uiSource, 'shouldAppendEventBlockContent');
const clearEventBlockBodySource = extractFunctionSource(uiSource, 'clearEventBlockBody');
const renderEventBlockBodySource = extractFunctionSource(uiSource, 'renderEventBlockBody');
const ensureEventBlockLoadedSource = extractFunctionSource(uiSource, 'ensureEventBlockLoaded');

function makeElement() {
  const element = {
    dataset: {},
    children: [],
    clearCount: 0,
    appendChild(child) {
      this.children.push(child);
      return child;
    },
  };

  Object.defineProperty(element, 'childElementCount', {
    get() {
      return this.children.length;
    },
  });

  Object.defineProperty(element, 'innerHTML', {
    get() {
      return '';
    },
    set(value) {
      if (value === '') {
        this.clearCount += 1;
        this.children = [];
      }
    },
  });

  return element;
}

let resolveFirstFetch = null;
const fetchResponses = [
  new Promise((resolve) => {
    resolveFirstFetch = resolve;
  }),
  Promise.resolve({
    events: [
      { seq: 2, type: 'reasoning', content: 'first hidden step' },
      { seq: 3, type: 'tool_use', toolName: 'bash' },
      { seq: 4, type: 'tool_result', output: 'ok' },
    ],
  }),
];

const renderCalls = [];
const context = {
  console,
  Number,
  String,
  Array,
  fetchEventBlock: async () => {
    const next = fetchResponses.shift();
    assert.ok(next, 'fetchEventBlock should receive an available response');
    return next;
  },
  buildLoadedHiddenBlockLabel() {
    return 'Thought';
  },
  createDeferredThinkingBlock() {
    return {
      block: makeElement(),
      header: { addEventListener() {} },
      body: makeElement(),
    };
  },
  renderHiddenBlockEventsInto(container, events) {
    renderCalls.push(events.map((event) => event.seq));
    for (const event of events) {
      container.appendChild({ seq: event.seq, type: event.type });
    }
  },
};
context.globalThis = context;

vm.runInNewContext(
  [
    parseEventBlockSeqSource,
    getRenderedEventBlockStartSeqSource,
    getRenderedEventBlockEndSeqSource,
    setRenderedEventBlockRangeSource,
    hasRenderedEventBlockContentSource,
    shouldAppendEventBlockContentSource,
    clearEventBlockBodySource,
    renderEventBlockBodySource,
    ensureEventBlockLoadedSource,
    'globalThis.ensureEventBlockLoaded = ensureEventBlockLoaded;',
  ].join('\n\n'),
  context,
  { filename: 'static/chat/ui.js' },
);

const body = makeElement();

const initialLoad = context.ensureEventBlockLoaded('session_test', body, {
  blockStartSeq: 2,
  blockEndSeq: 3,
});

assert.deepEqual(
  body.children,
  [],
  'expanded hidden blocks should stay empty while data is fetching instead of rendering a temporary loading placeholder',
);

resolveFirstFetch({
  events: [
    { seq: 2, type: 'reasoning', content: 'first hidden step' },
    { seq: 3, type: 'tool_use', toolName: 'bash' },
  ],
});

await initialLoad;

assert.deepEqual(
  body.children.map((child) => child.seq),
  [2, 3],
  'the first load should render the full hidden block body',
);

const clearCountAfterInitialLoad = body.clearCount;

await context.ensureEventBlockLoaded('session_test', body, {
  blockStartSeq: 2,
  blockEndSeq: 4,
});

assert.deepEqual(
  renderCalls,
  [[2, 3], [4]],
  'running block refreshes should append only the newly arrived hidden events',
);
assert.deepEqual(
  body.children.map((child) => child.seq),
  [2, 3, 4],
  'the rendered block body should keep existing nodes and add new ones at the end',
);
assert.equal(
  body.clearCount,
  clearCountAfterInitialLoad,
  'refreshing an expanded running block should not clear the already rendered body before appending',
);

console.log('test-chat-event-block-append: ok');
