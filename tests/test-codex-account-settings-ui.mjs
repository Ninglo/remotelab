import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../static/chat/settings-ui.js', import.meta.url), 'utf8');
const nodes = new Map();
const element = () => ({ textContent: '', hidden: false, disabled: false, children: [], dataset: {},
  setAttribute(name, value) { this[name] = value; },
  addEventListener(type, listener) { this[type] = listener; },
  append(...children) { this.children.push(...children); },
  replaceChildren(...children) { this.children = children; } });
const node = id => {
  if (!nodes.has(id)) nodes.set(id, element());
  return nodes.get(id);
};
const context = vm.createContext({
  console, settingsPanel: {}, currentPerson: { administrator: true }, canManageInstanceSettingsFromUi: () => true,
  document: { documentElement: { lang: 'zh-CN' }, getElementById: node, createElement: element },
  window: { setInterval: () => 1, clearInterval() {}, confirm: () => true },
});
vm.runInContext(source.slice(0, source.indexOf('function getPiAuthCopy()')), context);
const run = code => vm.runInContext(code, context);
const account = { type: 'chatgpt', name: '<img src=x onerror=alert(1)>', email: 'person@example.com', planType: 'pro' };
const quota = { status: 'ready', accountRevision: 'new', checkedAt: '2030-01-01T00:00:00Z', buckets: [
  { id: 'codex', primary: { remainingPercent: 75, windowDurationMins: 300, resetsAt: '2030-01-01T05:00:00Z' }, secondary: { remainingPercent: 0, windowDurationMins: 10080, resetsAt: null } },
] };
context.state = { loggedIn: true, accountRevision: 'new', account, usage: quota };
run('codexAuthState = state; renderCodexAuthPanel()');
assert.ok(node('settingsCodexAuthAccount').textContent.includes(account.name), 'identity is rendered as literal text');
assert.match(node('settingsCodexAuthAccount').textContent, /person@example.com/);
assert.match(node('settingsCodexAuthUsage').textContent, /5小时 额度：剩余 75%/);
assert.match(node('settingsCodexAuthUsage').textContent, /7天 额度：剩余 0%/);
assert.match(node('settingsCodexAuthUsage').textContent, /额度更新于/);
run('codexAuthState = { loggedIn: false }; renderCodexAuthPanel()');
assert.equal(node('settingsCodexAuthAccount').hidden, true);
assert.equal(node('settingsCodexAuthAccount').textContent, '');
assert.equal(node('settingsCodexAuthUsage').textContent, '');
context.document.documentElement.lang = 'en';
run('codexAuthState = { loggedIn: true, account: { type: "apiKey" }, usage: { status: "unsupported" } }; renderCodexAuthPanel()');
assert.match(node('settingsCodexAuthAccount').textContent, /API key sign-in/);
assert.match(node('settingsCodexAuthUsage').textContent, /not provided/);
run('codexAuthState = state');
let finishUsage;
context.fetchJsonOrRedirect = async url => {
  if (url.includes('rate-limits')) return new Promise(resolve => { finishUsage = resolve; });
  return { codexAuth: { ...context.state, usage: undefined } };
};
const request = run('refreshCodexAuthStatus({ force: true })');
await new Promise(resolve => setImmediate(resolve));
run('codexAuthRequestId++; codexAuthState = { loggedIn: false }; renderCodexAuthPanel()');
finishUsage({ codexUsage: quota });
await request;
assert.equal(node('settingsCodexAuthUsage').textContent, '', 'an old quota response cannot reappear after switching');
context.fetchJsonOrRedirect = async url => url.includes('rate-limits')
  ? { codexUsage: { ...quota, accountRevision: 'old' } } : { codexAuth: { ...context.state, usage: undefined } };
await run('refreshCodexAuthStatus()');
assert.match(node('settingsCodexAuthUsage').textContent, /temporarily unavailable/, 'different account revisions cannot be combined');
assert.doesNotMatch(node('settingsCodexAuthUsage').textContent, /75%/);
context.accountList = { activeId: 'a', autoSwitch: true, balanceSessions: true, routingAccountIds: ['a', 'b'], accounts: [
  { id: 'a', label: '<script>alert(1)</script>', active: true, account, availability: 'available', usage: quota },
  { id: 'b', label: '备用', account, availability: 'unknown' },
  { id: 'c', label: '待登录', account: null, availability: 'unknown' },
] };
run('codexAuthState.accountList = accountList; renderCodexSavedAccounts()');
const rows = node('settingsCodexAccountList').children;
assert.equal(rows.length, 3);
assert.ok(rows[0].children[0].textContent.includes('<script>'), 'saved labels remain literal text');
const button = (row, action) => row.children.find(child => child.dataset.codexAccountAction === action);
assert.equal(button(rows[0], 'enable').disabled, true);
assert.deepEqual(rows[0].children.filter(child => child.type === 'button').map(child => child.textContent),
  ['Enable use', 'Temporarily disable', 'Remove']);
assert.equal(node('settingsCodexAutoSwitch').checked, true);
assert.equal(node('settingsCodexBalanceSessions').checked, true);
context.selected = null; context.changed = null; context.removed = null;
run('startCodexDeviceLogin = async id => { selected = id; }; setCodexAccountRouting = async (id, enabled) => { changed = {id, enabled}; return true; }; removeCodexAccount = async id => { removed = id; }');
await button(rows[1], 'disable').click(); assert.equal(context.changed.id, 'b'); assert.equal(context.changed.enabled, false);
assert.equal(context.selected, null, 'disabling preserves the login');
await button(rows[2], 'enable').click(); assert.equal(context.selected, 'c');
await button(rows[0], 'remove').click(); assert.equal(context.removed, 'a');
assert.match(rows[2].children[2].textContent, /disabled.*Sign-in required/);
context.accountList.disabledAccountIds = ['a'];
run('renderCodexSavedAccounts()');
assert.equal(button(node('settingsCodexAccountList').children[1], 'enable').disabled, true,
  'the disabled exceptions, not a stale allowlist, determine the UI state');
context.currentPerson.administrator = false;
run('renderCodexSavedAccounts()');
assert.equal(node('settingsCodexAccountList').hidden, true, 'ordinary users never see pool controls');
console.log('Codex settings identity, quota, localization, routing visibility and stale-response tests passed');
