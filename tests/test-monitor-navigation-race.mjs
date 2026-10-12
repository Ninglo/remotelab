import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const compose = await readFile(new URL('../static/chat/compose.js', import.meta.url), 'utf8');
const http = await readFile(new URL('../static/chat/session-http.js', import.meta.url), 'utf8');
const context = vm.createContext({
  activeTab: 'sessions', pendingNavigationState: {tab:'sessions',sessionId:'s1'},
  normalizeSidebarTab: x=>x, document: {body:{dataset:{}}}, window: {},
  syncBrowserState() {}, currentSessionId:null, hasAttachedSession:false,
  resolveRestoreTargetSession:()=>({id:'s1'}), attachSession() {},
});
vm.runInContext(compose.slice(compose.indexOf('function switchTab('), compose.indexOf('\nif (typeof tabTasks !==', compose.indexOf('function switchTab('))),context);
vm.runInContext(http.slice(0,http.indexOf('\nfunction canOrganizeSessionListFromUi')),context);
vm.runInContext('switchTab("tasks"); restoreSessionSelection();',context);
assert.equal(context.activeTab,'tasks','late initial Session response must not take the user out of Monitor');
context.pendingNavigationState={tab:'sessions',sessionId:'s1'};
vm.runInContext('switchTab("settings");',context);
assert.equal(context.pendingNavigationState.sessionId,'s1','changing workspace preserves the pending Session selection');
vm.runInContext('restoreSessionSelection();',context);
assert.equal(context.activeTab,'settings');
context.pendingNavigationState={tab:'tasks'};
vm.runInContext('switchTab("sessions", {syncState:false}); restoreSessionSelection();',context);
assert.equal(context.activeTab,'tasks','initial setup must still honor the original deep link');
console.log('Early Monitor/settings navigation survives deferred initial Session restore; deep links preserved.');
