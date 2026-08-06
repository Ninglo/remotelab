#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const source = readFileSync(join(repoRoot, 'static', 'chat', 'session-list-ui.js'), 'utf8');

const start = source.indexOf('let activeSessionRename');
const end = source.indexOf('\nfunction attachSession');
assert.notEqual(start, -1, 'rename editor state should exist');
assert.notEqual(end, -1, 'attachSession should mark the end of session-list rename helpers');
const renameEditorSource = source.slice(start, end);

class FakeInput {
  constructor() {
    this.value = '';
    this.className = '';
    this.listeners = new Map();
    this.focusCalls = [];
    this.selectCalls = 0;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  dispatch(type, event = {}) {
    const dispatchedEvent = {
      key: '',
      isComposing: false,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...event,
    };
    for (const handler of this.listeners.get(type) || []) {
      handler(dispatchedEvent);
    }
    return dispatchedEvent;
  }

  focus(options) {
    this.focusCalls.push(options || null);
  }

  select() {
    this.selectCalls += 1;
  }
}

function createRenameItem() {
  const state = {
    input: null,
    nameEl: null,
  };
  state.nameEl = {
    replaceWith(node) {
      state.input = node;
    },
  };
  return {
    state,
    querySelector(selector) {
      return selector === '.session-item-name' ? state.nameEl : null;
    },
  };
}

const actions = [];
let listInput = null;
const context = {
  console,
  document: {
    createElement(tagName) {
      assert.equal(tagName, 'input', 'rename editor should only create an input in this test');
      return new FakeInput();
    },
  },
  dispatchAction(action) {
    actions.push(action);
    return Promise.resolve(true);
  },
  renderSessionList() {
    throw new Error('renderSessionList should not be called by these commit paths');
  },
  sessionList: {
    querySelector(selector) {
      return selector === '.session-rename-input' ? listInput : null;
    },
  },
};
context.globalThis = context;

vm.runInNewContext(
  `${renameEditorSource}
globalThis.startRename = startRename;
globalThis.renderActiveSessionRenameEditor = renderActiveSessionRenameEditor;
globalThis.refocusActiveSessionRenameInput = refocusActiveSessionRenameInput;
globalThis.__setSessionListRenderDepth = (value) => { sessionListRenderDepth = value; };
globalThis.__getActiveSessionRename = () => activeSessionRename ? { ...activeSessionRename } : null;`,
  context,
  { filename: 'static/chat/session-list-ui.js' },
);

const firstItem = createRenameItem();
context.startRename(firstItem, { id: 'sess_a', name: 'Old title', tool: 'codex' });
const firstInput = firstItem.state.input;
assert.equal(firstInput.value, 'Old title');
assert.equal(firstInput.selectCalls, 1, 'starting rename should select the current title');
assert.equal(firstInput.focusCalls.length, 1, 'starting rename should focus the input');

firstInput.value = 'Draft title';
firstInput.dispatch('input');
context.__setSessionListRenderDepth(1);
firstInput.dispatch('blur');
assert.deepEqual(actions, [], 'blur caused by sidebar re-render should not commit a rename');
assert.equal(
  JSON.stringify(context.__getActiveSessionRename()),
  JSON.stringify({ sessionId: 'sess_a', originalName: 'Old title', draftName: 'Draft title' }),
  'render-time blur should preserve the in-progress draft',
);

context.__setSessionListRenderDepth(0);
const restoredItem = createRenameItem();
assert.equal(
  context.renderActiveSessionRenameEditor(restoredItem, { id: 'sess_a', name: 'Old title' }),
  true,
  'active rename should restore after the session row is rebuilt',
);
const restoredInput = restoredItem.state.input;
assert.equal(restoredInput.value, 'Draft title', 'restored rename editor should keep the typed draft');

listInput = restoredInput;
context.refocusActiveSessionRenameInput();
assert.equal(restoredInput.focusCalls.length, 1, 'restored rename editor should be focusable after render');

restoredInput.value = '中文标题';
restoredInput.dispatch('input');
restoredInput.dispatch('compositionstart');
const composingEnter = restoredInput.dispatch('keydown', { key: 'Enter' });
assert.equal(composingEnter.defaultPrevented, false, 'IME candidate Enter should be left to the input method');
assert.deepEqual(actions, [], 'IME candidate Enter should not commit the rename');

restoredInput.dispatch('compositionend');
const commitEnter = restoredInput.dispatch('keydown', { key: 'Enter' });
assert.equal(commitEnter.defaultPrevented, true, 'plain Enter should be handled as rename commit');
assert.equal(
  JSON.stringify(actions),
  JSON.stringify([{ action: 'rename', sessionId: 'sess_a', name: '中文标题' }]),
  'plain Enter after composition ends should commit the final title',
);
assert.equal(context.__getActiveSessionRename(), null, 'committing should clear active rename state');

console.log('test-chat-session-rename-editor: ok');
