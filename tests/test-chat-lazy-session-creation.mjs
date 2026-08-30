#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const source = readFileSync(join(repoRoot, 'static/chat/sidebar-ui.js'), 'utf8');
const sessionHttpSource = readFileSync(join(repoRoot, 'static/chat/session-http.js'), 'utf8');

function extractFunction(functionName, fromSource = source) {
  const marker = `function ${functionName}`;
  const markerStart = fromSource.indexOf(marker);
  assert.notEqual(markerStart, -1, `${functionName} should exist`);
  const start = fromSource.slice(Math.max(0, markerStart - 6), markerStart) === 'async '
    ? markerStart - 6
    : markerStart;
  const paramsStart = fromSource.indexOf('(', start);
  let paramsDepth = 0;
  let bodyStart = -1;
  for (let index = paramsStart; index < fromSource.length; index += 1) {
    if (fromSource[index] === '(') paramsDepth += 1;
    if (fromSource[index] === ')') {
      paramsDepth -= 1;
      if (paramsDepth === 0) {
        bodyStart = fromSource.indexOf('{', index);
        break;
      }
    }
  }
  assert.notEqual(bodyStart, -1, `${functionName} should have a body`);
  let depth = 0;
  for (let index = bodyStart; index < fromSource.length; index += 1) {
    if (fromSource[index] === '{') depth += 1;
    if (fromSource[index] === '}') {
      depth -= 1;
      if (depth === 0) return fromSource.slice(start, index + 1);
    }
  }
  throw new Error(`Unable to extract ${functionName}`);
}

const snippet = [
  'const DETACHED_COMPOSER_SESSION_ID = "__new_session_draft__";',
  'let pendingNewSessionCreateOptions = null;',
  extractFunction('getActiveComposerSessionId'),
  extractFunction('buildNewSessionCreateAction'),
  extractFunction('materializeNewSessionShortcut'),
  extractFunction('createNewSessionShortcut'),
  'globalThis.readPendingCreateOptions = () => pendingNewSessionCreateOptions;',
].join('\n\n');

const calls = {
  dispatch: [],
  clearComposer: [],
  browser: [],
  titles: [],
  focus: [],
  empty: 0,
};
const context = {
  console,
  Promise,
  currentSessionId: 'existing-session',
  hasAttachedSession: true,
  visitorMode: false,
  isDesktop: true,
  preferredTool: 'codex',
  selectedTool: 'codex',
  toolsList: [{ id: 'codex' }],
  DEFAULT_APP_ID: 'chat',
  DEFAULT_WEB_SOURCE_NAME: 'RemoteLab',
  window: {
    remotelabGetDefaultSessionFolder() {
      return '/workspace';
    },
  },
  localStorage: {
    removeItem() {},
  },
  hasAuthCapability(name) {
    return name === 'createSession';
  },
  getPreferredAgentTemplateId() {
    return 'agent-review';
  },
  getPreferredAgentTemplateName() {
    return 'Review';
  },
  switchTab() {},
  settleAttachedSessionSidebarState() {
    return Promise.resolve();
  },
  setChatCurrentSession(sessionId, options = {}) {
    context.currentSessionId = sessionId;
    context.hasAttachedSession = options.hasAttachedSession === true;
  },
  getComposerAttachmentsState() {
    return [];
  },
  releaseImageObjectUrls() {},
  clearComposerSessionState(sessionId, options) {
    calls.clearComposer.push({ sessionId, options });
  },
  resetAttachedSessionRenderState() {},
  persistActiveSessionId() {},
  syncBrowserState(state) {
    calls.browser.push(state);
  },
  showEmpty() {
    calls.empty += 1;
  },
  renderHeaderSessionTitle(title) {
    calls.titles.push(title);
  },
  restoreDraft() {},
  updateStatus() {},
  renderSessionList() {},
  focusComposer(options) {
    calls.focus.push(options);
  },
  t(key) {
    return key === 'session.newDraftName' ? 'New session' : key;
  },
  async dispatchAction(action) {
    calls.dispatch.push(action);
    context.currentSessionId = 'created-session';
    return true;
  },
};
context.globalThis = context;
vm.runInNewContext(snippet, context, { filename: 'sidebar-ui-lazy-session.js' });

const opened = context.createNewSessionShortcut({
  sourceContext: { channel: 'pwa_shortcut' },
});
assert.equal(opened, true);
assert.equal(calls.dispatch.length, 0, 'opening the new-session surface must not call the backend');
assert.equal(context.currentSessionId, null, 'opening the surface should detach the persisted session');
assert.equal(calls.empty, 1, 'opening the surface should render the local empty state');
assert.deepEqual(calls.titles, ['New session']);
assert.equal(calls.clearComposer[0]?.sessionId, '__new_session_draft__');
assert.equal(calls.focus.length, 1, 'opening the surface should focus the composer');
assert.equal(context.getActiveComposerSessionId(), '__new_session_draft__');
assert.equal(context.readPendingCreateOptions()?.sourceContext?.channel, 'pwa_shortcut');

const materialized = await context.materializeNewSessionShortcut();
assert.equal(materialized, true);
assert.equal(calls.dispatch.length, 1, 'the first send path should materialize exactly one backend session');
assert.equal(calls.dispatch[0]?.action, 'create');
assert.equal(calls.dispatch[0]?.tool, 'codex');
assert.equal(calls.dispatch[0]?.templateId, 'agent-review');
assert.equal(calls.dispatch[0]?.sourceContext?.channel, 'pwa_shortcut');
assert.equal(context.currentSessionId, 'created-session');
assert.equal(context.readPendingCreateOptions(), null, 'creation metadata should clear after materialization');

const restoreCalls = [];
const restoreContext = {
  visitorMode: false,
  activeTab: 'sessions',
  pendingNavigationState: null,
  currentSessionId: null,
  getActiveSidebarTabValue() {
    return 'sessions';
  },
  isNewSessionDraftActive() {
    return true;
  },
  syncBrowserState(state) {
    restoreCalls.push(state);
  },
  resolveRestoreTargetSession() {
    throw new Error('a live local draft must not resolve a persisted session');
  },
};
restoreContext.globalThis = restoreContext;
vm.runInNewContext(
  `${extractFunction('restoreOwnerSessionSelection', sessionHttpSource)}\nglobalThis.restoreOwnerSessionSelection = restoreOwnerSessionSelection;`,
  restoreContext,
  { filename: 'session-http-lazy-session.js' },
);
restoreContext.restoreOwnerSessionSelection();
assert.equal(restoreCalls.length, 1, 'background list refreshes should preserve the local new-session surface');
assert.equal(restoreCalls[0]?.sessionId, null);

console.log('test-chat-lazy-session-creation: ok');
