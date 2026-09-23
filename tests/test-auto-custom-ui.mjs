import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../static/chat/sidebar-ui.js'), 'utf8');
function extract(name) {
  const marker = source.indexOf(`function ${name}`);
  assert.ok(marker >= 0, `${name} exists`);
  const start = source.slice(Math.max(0, marker - 6), marker) === 'async ' ? marker - 6 : marker;
  const open = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Cannot extract ${name}`);
}

function element() {
  const classes = new Set();
  return {
    hidden: false,
    textContent: '',
    classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }, contains(name) { return classes.has(name); } },
    setAttribute(name, value) { this[name] = value; },
  };
}

const actions = [];
const context = {
  currentSessionId: null,
  current: null,
  sessionProfileControl: element(),
  quickProfileBadge: element(),
  runtimeSelectionControls: element(),
  autoModeBtn: element(),
  customModeBtn: element(),
  t(key) { return key; },
  getCurrentSession() { return context.current; },
  async loadModelsForCurrentTool() {},
  async dispatchAction(action) {
    actions.push(action);
    context.current = action.model === 'auto'
      ? { tool: 'codex', model: 'auto', effort: '' }
      : { ...context.current, model: action.model, effort: action.effort, autoRouting: null };
    return true;
  },
};
vm.runInNewContext([
  'let pendingNewSessionCreateOptions = null;',
  ...['getDraftRuntimeMode', 'isQuickSessionUi', 'getActiveRuntimeModeUi', 'syncQuickSessionUi', 'setDraftRuntimeMode', 'selectRuntimeMode'].map(extract),
  'globalThis.mode = getActiveRuntimeModeUi;',
  'globalThis.sync = syncQuickSessionUi;',
  'globalThis.select = selectRuntimeMode;',
].join('\n'), context);

context.sync(null);
assert.equal(context.mode(null), 'auto');
assert.equal(context.runtimeSelectionControls.hidden, true);
assert.equal(context.autoModeBtn['aria-pressed'], 'true');
await context.select('custom');
assert.equal(context.mode(null), 'custom');
assert.equal(context.runtimeSelectionControls.hidden, false);

context.currentSessionId = 'session-1';
context.current = { tool: 'codex', model: 'auto', effort: '' };
context.sync(context.current);
assert.equal(context.mode(context.current), 'auto');
assert.equal(context.sessionProfileControl.hidden, false);
assert.equal(context.runtimeSelectionControls.hidden, true);

await context.select('custom');
assert.equal(actions.at(-1).model, 'gpt-6-sol');
assert.equal(context.mode(context.current), 'custom');
assert.equal(context.runtimeSelectionControls.hidden, false);

await context.select('auto');
assert.equal(actions.at(-1).model, 'auto');
assert.equal(context.mode(context.current), 'auto');

context.current = {
  tool: 'codex', model: 'gpt-6-sol', effort: 'low', runtimeTier: 'quick',
  lastUserMessageAt: '2026-09-23T12:00:00Z',
  autoRouting: { status: 'routed', decision: { tier: 'quick' } },
};
context.sync(context.current);
assert.equal(context.mode(context.current), null);
assert.equal(context.sessionProfileControl.hidden, true);
assert.equal(context.runtimeSelectionControls.hidden, false);
const actionCount = actions.length;
assert.equal(await context.select('auto'), false);
assert.equal(actions.length, actionCount, 'a started Session cannot return to Auto');

context.current = { tool: 'codex', model: 'gpt-6-sol', effort: 'medium', lastUserMessageAt: '2026-09-23T12:00:00Z' };
context.sync(context.current);
assert.equal(context.sessionProfileControl.hidden, true);
assert.equal(context.runtimeSelectionControls.hidden, false);

context.current.executionProfile = 'quick';
context.sync(context.current);
assert.equal(context.sessionProfileControl.hidden, true);
assert.equal(context.quickProfileBadge.hidden, false);
assert.equal(context.runtimeSelectionControls.hidden, true);

console.log('test-auto-custom-ui: ok');
