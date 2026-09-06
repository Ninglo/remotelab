#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const sessionSurfaceUiSource = readFileSync(join(repoRoot, 'static', 'chat', 'session-surface-ui.js'), 'utf8');

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

const renderSessionMessageCountSource = extractFunctionSource(sessionSurfaceUiSource, 'renderSessionMessageCount');
const buildSessionMetaPartsSource = extractFunctionSource(sessionSurfaceUiSource, 'buildSessionMetaParts');
const getSessionRowStatusInfoSource = extractFunctionSource(sessionSurfaceUiSource, 'getSessionRowStatusInfo');
const renderSessionStatusIndicatorSource = extractFunctionSource(sessionSurfaceUiSource, 'renderSessionStatusIndicator');

const state = { scopeCalls: 0, statusCalls: 0 };
const context = {
  console,
  t(key, vars = {}) {
    if (key === 'session.messagesTitle') return 'Messages in this session';
    if (key === 'session.messages') return `${vars.count} msg${vars.suffix || ''}`;
    if (key === 'session.rowStatus.review') return 'review';
    return key;
  },
  esc(value) {
    return String(value || '');
  },
  renderSessionScopeContext() {
    state.scopeCalls += 1;
    return ['<span>scope</span>'];
  },
  getSessionReviewStatusInfo(session) {
    return session?.reviewStatus || null;
  },
  getSessionStatusSummary(session) {
    return { primary: session?.liveStatus || { key: 'idle', label: '' } };
  },
  renderSessionStatusHtml(statusInfo) {
    if (!statusInfo?.label) return '';
    state.statusCalls += 1;
    return `<span>${statusInfo.label}</span>`;
  },
};
context.globalThis = context;
vm.runInNewContext(
  `${renderSessionMessageCountSource}\n${buildSessionMetaPartsSource}\n${getSessionRowStatusInfoSource}\n${renderSessionStatusIndicatorSource}\nglobalThis.renderSessionMessageCount = renderSessionMessageCount;\nglobalThis.buildSessionMetaParts = buildSessionMetaParts;\nglobalThis.getSessionRowStatusInfo = getSessionRowStatusInfo;\nglobalThis.renderSessionStatusIndicator = renderSessionStatusIndicator;`,
  context,
  { filename: 'static/chat/session-surface-ui.js' },
);

assert.equal(
  context.renderSessionMessageCount({ messageCount: 5, activeMessageCount: 2 }),
  '<span class="session-item-count" title="Messages in this session">(5)</span>',
  'session list should show the full session message count, not the active-context count',
);

const parts = context.buildSessionMetaParts({ messageCount: 5 });
assert.equal(
  JSON.stringify(parts),
  JSON.stringify([
    '<span class="session-item-count" title="Messages in this session">(5)</span>',
  ]),
  'session list metadata should keep only the compact message count in the detail line',
);
assert.equal(state.scopeCalls, 0, 'session list metadata should not render source/app/user scope labels anymore');
assert.equal(state.statusCalls, 0, 'session list metadata should not render verbose status text');

const runningStatus = { key: 'running', label: 'running' };
const unreadStatus = { key: 'unread', label: 'new' };
assert.equal(
  context.getSessionRowStatusInfo({ liveStatus: runningStatus, workflowState: 'done', reviewStatus: unreadStatus }),
  runningStatus,
  'running should be the only live state that renders a row dot',
);
assert.equal(
  context.getSessionRowStatusInfo({ liveStatus: { key: 'queued', label: 'queued' }, workflowState: 'active' }),
  null,
  'queued and other transient states should not add decorative row dots',
);
assert.equal(
  JSON.stringify(context.getSessionRowStatusInfo({ workflowState: 'done', reviewStatus: unreadStatus })),
  JSON.stringify({ ...unreadStatus, label: 'review' }),
  'completed unread work should render an explicit review status',
);
assert.equal(
  JSON.stringify(context.getSessionRowStatusInfo({ workflowState: 'waiting_user', reviewStatus: unreadStatus })),
  JSON.stringify({ ...unreadStatus, label: 'review' }),
  'new results should remain visible for review even when workflow classification is not done',
);
assert.equal(
  JSON.stringify(context.getSessionRowStatusInfo({ workflowState: '', reviewStatus: unreadStatus })),
  JSON.stringify({ ...unreadStatus, label: 'review' }),
  'new results should become reviewable immediately before workflow classification completes',
);
assert.equal(
  context.getSessionRowStatusInfo({ workflowState: 'done' }),
  null,
  'reviewed completed work should not render a dot',
);

assert.equal(
  context.renderSessionStatusIndicator({
    key: 'running',
    label: 'running',
    className: 'status-running',
    title: 'Currently running',
  }),
  '<span class="session-row-status status-running" title="Currently running"><span class="session-status-dot" aria-hidden="true"></span>running</span>',
  'running sessions should pair the pulsing dot with a visible text label',
);

assert.equal(
  context.renderSessionStatusIndicator({
    key: 'unread',
    label: 'review',
    className: 'status-unread',
    title: 'New result',
  }),
  '<span class="session-row-status status-unread" title="New result"><span class="session-status-dot" aria-hidden="true"></span>review</span>',
  'sessions with unchecked results should pair the attention dot with a visible text label',
);

console.log('test-chat-session-list-meta: ok');
