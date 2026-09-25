import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../static/chat/settings-ui.js', import.meta.url), 'utf8');
const start = source.indexOf('function getClaudeAuthCopy()');
const end = source.indexOf('function temporarilyUpdateButtonLabel(', start);
assert.ok(start >= 0 && end > start);
const nodes = new Map();
const node = id => {
  if (!nodes.has(id)) nodes.set(id, { hidden: false, disabled: false, textContent: '', value: '', href: '' });
  return nodes.get(id);
};
node('settingsClaudeAuthSection');
const context = vm.createContext({
  document: { documentElement: { lang: 'zh-CN' }, getElementById: node },
  window: { setInterval: () => 1, clearInterval() {} },
  settingsPanel: {},
  canManageInstanceSettingsFromUi: () => true,
  claudeAuthState: null,
  claudeAuthPollTimer: null,
});
vm.runInContext(`${source.slice(start, end)}\nclaudeAuthState = {
  loggedIn: true, authMethod: 'claude_ai', apiKeyOverride: true,
}; renderClaudeAuthPanel();`, context);
assert.equal(node('settingsClaudeAuthPill').textContent, 'Claude 账号已登录');
assert.equal(node('settingsClaudeAuthOverride').hidden, false);
assert.match(node('settingsClaudeAuthOverride').textContent, /API Key/);
assert.equal(node('settingsClaudeAuthLogoutBtn').hidden, false);

vm.runInContext(`claudeAuthState = {
  loggedIn: false, loginActive: true, phase: 'awaiting',
  verificationUri: 'https://claude.com/cai/oauth/authorize?state=fixture',
  apiKeyOverride: true,
}; renderClaudeAuthPanel();`, context);
assert.equal(node('settingsClaudeAuthDevice').hidden, false);
assert.equal(node('settingsClaudeAuthLink').href, 'https://claude.com/cai/oauth/authorize?state=fixture');
assert.match(node('settingsClaudeAuthCode').placeholder, /授权码/);
assert.equal(node('settingsClaudeAuthCodeBtn').disabled, true);
node('settingsClaudeAuthCode').value = 'fixture-code';
vm.runInContext('renderClaudeAuthPanel()', context);
assert.equal(node('settingsClaudeAuthCodeBtn').disabled, false);

console.log('Claude auth settings UI tests passed');
