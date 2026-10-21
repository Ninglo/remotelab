import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const compose = await readFile(new URL('../static/chat/compose.js', import.meta.url), 'utf8');
const http = await readFile(new URL('../static/chat/session-http.js', import.meta.url), 'utf8');
const bootstrap = await readFile(new URL('../static/chat/bootstrap.js', import.meta.url), 'utf8');
const catalog = await readFile(new URL('../static/chat/bootstrap-session-catalog.js', import.meta.url), 'utf8');
const storage = new Map([['activeSidebarTab', 'settings']]);
const buttons = new Map();
function button(id) {
  if (!buttons.has(id)) buttons.set(id, {
    classList: { toggle() {} }, setAttribute() {}, removeAttribute() {},
    addEventListener(event, callback) { this[event] = callback; },
  });
  return buttons.get(id);
}
const context = vm.createContext({
  URL, URLSearchParams, pendingNavigationState: {tab:'sessions',sessionId:'s1'},
  document: {body:{dataset:{}}, getElementById: button}, window: { location: { origin: 'https://example.test' } },
  localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
  ACTIVE_SIDEBAR_TAB_STORAGE_KEY: 'activeSidebarTab', isNavigationPersistenceEnabled: () => true,
  tabSettings: button('tabSettings'), tabTasks: button('tabTasks'),
  syncBrowserState() {}, currentSessionId:null, hasAttachedSession:false,
  resolveRestoreTargetSession:()=>({id:'s1'}), attachSession() {},
});
vm.runInContext(bootstrap.slice(bootstrap.indexOf('function normalizeSidebarTab('), bootstrap.indexOf('let pendingNavigationState')), context);
vm.runInContext(bootstrap.slice(bootstrap.indexOf('function getInitialSidebarTab('), bootstrap.indexOf('let currentSessionId =')), context);
vm.runInContext(catalog.slice(catalog.indexOf('function persistActiveSidebarTab('), catalog.indexOf('function buildNavigationUrl(')), context);
const initialTab = raw => {
  context.pendingNavigationState = context.normalizeNavigationState(raw);
  return context.getInitialSidebarTab();
};
assert.equal(initialTab({ sessionId: 's1' }), 'sessions', 'Session links override stale Settings storage');
assert.equal(initialTab({ url: '/?session=s1' }), 'sessions', 'notification URL navigation returns to the conversation');
assert.equal(initialTab({}), 'sessions', 'old sticky Settings state must not reopen on a fresh visit');
assert.equal(initialTab({ sessionId: 's1', tab: 'settings' }), 'settings', 'explicit Settings links remain supported');
storage.set('activeSidebarTab', 'tasks');
assert.equal(initialTab({}), 'tasks', 'ordinary workspace restoration remains intact');
assert.equal(initialTab({ sessionId: 's1' }), 'sessions', 'Session links also override stored Monitor state');
context.persistActiveSidebarTab('settings');
assert.equal(storage.get('activeSidebarTab'), 'tasks', 'opening Settings does not persist it as the next workspace');
vm.runInContext(compose.slice(compose.indexOf('// ---- Application views ----'), compose.indexOf('switchTab(activeTab, { syncState: false });') + 'switchTab(activeTab, { syncState: false });'.length), context);
const activeTab = () => vm.runInContext('activeTab', context);
vm.runInContext(http.slice(0,http.indexOf('\nfunction canOrganizeSessionListFromUi')),context);
vm.runInContext('switchTab("tasks"); restoreSessionSelection();',context);
assert.equal(activeTab(),'tasks','late initial Session response must not take the user out of Monitor');
context.pendingNavigationState={tab:'sessions',sessionId:'s1'};
vm.runInContext('switchTab("settings");',context);
assert.equal(context.pendingNavigationState.sessionId,'s1','changing workspace preserves the pending Session selection');
vm.runInContext('restoreSessionSelection();',context);
assert.equal(activeTab(),'settings');
button('tabSettings').click();
assert.equal(activeTab(), 'tasks', 'clicking Settings again returns to the workspace that opened it');
vm.runInContext('switchTab("sessions");', context);
button('tabSettings').click();
assert.equal(activeTab(), 'settings');
button('closeSettingsBtn').click();
assert.equal(activeTab(), 'sessions', 'the visible close control returns to the conversation');
button('tabSettings').click();
context.pendingNavigationState = {tab:'settings',sessionId:'s1'};
button('tabSettings').click();
vm.runInContext('restoreSessionSelection();', context);
assert.equal(activeTab(), 'sessions', 'late Session restore must not reopen Settings after the user closes it');
context.pendingNavigationState={tab:'tasks'};
vm.runInContext('switchTab("sessions", {syncState:false}); restoreSessionSelection();',context);
assert.equal(activeTab(),'tasks','initial setup must still honor the original deep link');
console.log('Session links, transient Settings toggling, and deferred workspace restoration passed.');
