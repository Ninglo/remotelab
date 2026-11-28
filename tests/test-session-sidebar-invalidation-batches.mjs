import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../static/chat/realtime.js', import.meta.url), 'utf8');
const timers = new Map(), listeners = new Map(), sidebar = [], index = [], issues = [];
let sequence = 0;
const context = {
  console, currentSessionId: '', window: {},
  document: { hidden: false, addEventListener: (event, callback) => listeners.set(event, callback) },
  setTimeout(callback, ms) { assert.equal(ms, 250); const id = ++sequence; timers.set(id, callback); return id; },
  async refreshSidebarSession(id) { sidebar.push(id); },
  async syncSessionSidebarRefs() { index.push(1); },
  RemoteLabNotifications: { async refreshDeliveryIssues() { issues.push(1); } },
};
vm.runInNewContext(source, context);
async function flush() {
  const batch = [...timers.values()]; timers.clear();
  for (const fn of batch) await fn();
}
const id = sessionId => context.handleWsMessage({ type: 'session_invalidated', sessionId });
for (let i = 0; i < 20; i++) id(`s-${i}`);
assert.equal(timers.size, 1);
await flush();
assert.equal(sidebar.length, 20);
assert.equal(index.length, 0);
for (let i = 0; i < 10; i++) id('repeat');
await flush();
assert.equal(sidebar.filter(id => id === 'repeat').length, 1);
context.document.hidden = true;
id('hidden'); id('hidden');
context.handleWsMessage({ type: 'session_invalidated', sessionId: 'hidden', deliveryIssuesChanged: true });
assert.equal(timers.size, 0);
context.document.hidden = false;
listeners.get('visibilitychange')();
await flush();
assert.equal(sidebar.filter(id => id === 'hidden').length, 1);
assert.equal(issues.length, 1);
for (let i = 0; i < 10; i++) context.handleWsMessage({ type: 'sessions_invalidated' });
await flush();
assert.equal(index.length, 1);
assert.equal(sidebar.length, 22);
console.log('sidebar notices: 20 changed IDs, repeated IDs coalesced, hidden tab silent, global refs once');
