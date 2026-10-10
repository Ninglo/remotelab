import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../static/chat/notifications.js', import.meta.url), 'utf8');
const realtime = await readFile(new URL('../static/chat/realtime.js', import.meta.url), 'utf8');
const template = await readFile(new URL('../templates/chat.html', import.meta.url), 'utf8');
assert.ok(template.indexOf('src="chat/notifications.js') > 0);
assert.ok(template.indexOf('src="chat/notifications.js') < template.indexOf('src="chat/realtime.js'), 'the normal page must load notifications before action dispatch');
const actionSource = realtime.slice(realtime.indexOf('async function dispatchAction('), realtime.indexOf('\nfunction buildOptimisticArchivedSession('));

function page(storage = new Map(), person = 'person-a', storageUnavailable = false) {
  const elements = new Map();
  const documentEvents = new Map();
  const timers = new Map();
  let timerId = 0;
  function element(id = '') {
    const listeners = new Map();
    const node = {
      id, hidden: true, children: [], textContent: '', attributes: {}, dataset: {},
      appendChild(child) { child.parent = this; this.children.push(child); if (child.id) elements.set(child.id, child); },
      replaceChildren() { this.children = []; },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(type, callback) { listeners.set(type, callback); },
      click() { return listeners.get('click')?.({ target: this }); },
      focus() { this.focused = true; },
      contains(child) { return child === this || this.children.some(node => node.contains(child)); },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); },
      get firstElementChild() { return this.children[0]; },
    };
    if (id) elements.set(id, node);
    return node;
  }
  for (const id of ['notificationToggle', 'notificationPanel', 'notificationBadge', 'notificationList', 'notificationClear', 'notificationClose', 'notificationShowAll', 'notificationStatus', 'deliveryIssues']) element(id);
  const context = {
    console: { error() {} },
    document: {
      body: element(), documentElement: { lang: 'zh-CN' },
      getElementById: id => elements.get(id),
      createElement: () => element(),
      querySelector: () => ({ getAttribute: () => '/' }),
      addEventListener: (type, callback) => documentEvents.set(type, callback),
    },
    window: {
      __REMOTELAB_BOOTSTRAP__: { auth: { person: { id: person } } },
      addEventListener() {},
      remotelabT: (key, vars = {}) => ({
        'notifications.empty': '暂无通知', 'notifications.session': '打开会话', 'action.close': '关闭',
        'notifications.sendFailed': `消息未发送：${vars.error}`, 'notifications.actionFailed': `操作失败：${vars.error}`,
      })[key] || key,
    },
    localStorage: {
      getItem(key) { if (storageUnavailable) throw new Error('Blocked'); return storage.get(key); },
      setItem(key, value) { if (storageUnavailable) throw new Error('Blocked'); storage.set(key, value); },
    },
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
    currentSessionId: 'session-a',
    attachSession(sessionId) { context.openedSession = sessionId; },
    t(key, vars) { return context.window.remotelabT(key, vars); },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  vm.runInContext(actionSource, context);
  return { context, elements, storage, timers, documentEvents };
}

const test = page();
const busyError = '当前 Harness 正在运行；切换 Harness、模型或推理设置需要先停止当前任务，或在任务完成后发送。';
test.context.fetchJsonOrRedirect = async () => { throw Object.assign(new Error(busyError), { status: 409 }); };
assert.equal(await test.context.dispatchAction({ action: 'send', sessionId: 'session-a', requestId: 'test', text: 'steer', model: 'new-model' }), false);
const toastContainer = test.elements.get('system-toast-container');
assert.equal(toastContainer.children.length, 1);
assert.equal(toastContainer.children[0].attributes.role, 'alert');
assert.equal(toastContainer.children[0].children[0].textContent, `消息未发送：${busyError}`);
assert.equal(test.elements.get('notificationBadge').textContent, '1');
assert.equal(test.elements.get('notificationBadge').hidden, false);
assert.equal(test.elements.get('notificationList').children[0].children[1].textContent, `消息未发送：${busyError}`);
for (const callback of test.timers.values()) callback();
assert.equal(toastContainer.children.length, 0, 'toast expiry should not erase the notification history');
assert.equal(test.elements.get('notificationList').children.length, 1);

const reloaded = page(test.storage);
assert.equal(reloaded.elements.get('notificationBadge').textContent, '1', 'unread failures should survive reload');
reloaded.elements.get('notificationToggle').click();
assert.equal(reloaded.elements.get('notificationPanel').hidden, false);
assert.equal(reloaded.elements.get('notificationToggle').attributes['aria-expanded'], 'true');
assert.equal(reloaded.elements.get('notificationBadge').hidden, true);
reloaded.elements.get('notificationList').children[0].children[2].click();
assert.equal(reloaded.context.openedSession, 'session-a', 'the notification should return to the failed action session');
assert.equal(reloaded.elements.get('notificationPanel').hidden, true);

reloaded.context.showSystemToast('<img src=x onerror=alert(1)>', 'error');
assert.equal(reloaded.elements.get('notificationList').children[0].children[1].textContent, '<img src=x onerror=alert(1)>', 'server errors must be rendered as plain text');
assert.equal(reloaded.elements.get('notificationBadge').textContent, '1');
reloaded.elements.get('notificationToggle').click();
reloaded.documentEvents.get('keydown')({ key: 'Escape' });
assert.equal(reloaded.elements.get('notificationPanel').hidden, true);
assert.equal(reloaded.elements.get('notificationToggle').focused, true);

const otherPerson = page(test.storage, 'person-b');
assert.equal(otherPerson.elements.get('notificationBadge').hidden, true, 'a shared browser must not mix people notification history');
for (let index = 0; index < 55; index++) reloaded.context.showSystemToast(`Failure ${index}`, 'error');
assert.equal(reloaded.elements.get('notificationList').children.length, 50, 'history should be bounded');
assert.equal(reloaded.elements.get('system-toast-container').children.length, 3, 'a failure burst must not cover the whole page');
reloaded.elements.get('notificationClear').click();
assert.equal(reloaded.elements.get('notificationBadge').hidden, true);
assert.equal(page(test.storage).elements.get('notificationList').children[0].textContent, '暂无通知');

const unavailable = page(new Map(), 'person-a', true);
unavailable.context.showSystemToast('Network error', 'error');
assert.equal(unavailable.elements.get('notificationBadge').textContent, '1', 'blocked browser storage must not swallow errors');

const cancel = page();
cancel.context.fetchJsonOrRedirect = async () => { throw new Error('Stop failed'); };
assert.equal(await cancel.context.dispatchAction({ action: 'cancel' }), false);
assert.equal(cancel.elements.get('notificationList').children[0].children[1].textContent, '操作失败：Stop failed', 'other user action failures also need visible feedback');

const shared = page();
const issueA = { id: 'delivery-a', issueVersion: 'version-a', sessionId: 'session-a', sessionName: 'A', hasSession: true,
  state: 'delivery_failed', connector: 'feishu', lastError: 'A failed', createdAt: new Date().toISOString() };
const issueB = { ...issueA, id: 'delivery-b', issueVersion: 'version-b', sessionId: 'session-b', sessionName: 'B', lastError: 'B failed' };
let activeIssues = [issueA, issueB];
let releaseRefresh;
let holdRefresh = false;
let acknowledged;
const ack = new Promise(resolve => { acknowledged = resolve; });
const dismissed = [];
shared.context.fetchJsonOrRedirect = async (url, options) => {
  if (url === '/api/source-delivery-issues') {
    if (holdRefresh) {
      holdRefresh = false;
      const snapshot = activeIssues.slice();
      return new Promise(resolve => { releaseRefresh = () => resolve({ issues: snapshot }); });
    }
    return { issues: activeIssues.slice() };
  }
  assert.match(url, /delivery-a\/dismiss$/);
  assert.equal(JSON.parse(options.body).issueVersion, issueA.issueVersion);
  dismissed.push(issueA.id);
  activeIssues = [issueB];
  acknowledged();
  return { delivery: { ...issueA, state: 'delivery_failed', dismissedIssue: { issueVersion: issueA.issueVersion } } };
};
vm.runInContext('RemoteLabNotifications.setSessionContext({ id: "session-a", deliveryIssueCount: 1 })', shared.context);
await vm.runInContext('RemoteLabNotifications.refreshDeliveryIssues()', shared.context);
await vm.runInContext('RemoteLabNotifications.refreshDeliveryIssues()', shared.context);
assert.equal(shared.elements.get('notificationList').children.length, 2, 'refreshes project each durable issue once');
assert.equal(shared.elements.get('notificationBadge').textContent, '2');
const entry = shared.elements.get('deliveryIssues');
entry.children[1].click();
assert.equal(shared.elements.get('notificationList').children.length, 1, 'the conversation entry opens only its related notices');
assert.equal(shared.elements.get('notificationBadge').textContent, '1', 'a filtered view cannot mark other conversations read');
assert.equal(entry.hidden, false, 'viewing does not dismiss the delivery failure');
shared.elements.get('notificationClear').click();
assert.equal(shared.elements.get('notificationList').children.length, 1, 'clearing local history does not erase durable errors');

await vm.runInContext('RemoteLabNotifications.refreshDeliveryIssues()', shared.context);
holdRefresh = true;
const staleRefresh = vm.runInContext('RemoteLabNotifications.refreshDeliveryIssues()', shared.context);
const dismissal = shared.elements.get('notificationList').children[0].children.at(-1).click();
await ack;
releaseRefresh();
await Promise.all([staleRefresh, dismissal]);
assert.deepEqual(dismissed, ['delivery-a']);
assert.equal(entry.hidden, true, 'ignoring from the bell clears the conversation hint');
assert.equal(shared.elements.get('notificationList').children[0].className, 'notification-empty',
  'a refresh started before dismissal cannot revive its old warning');
shared.elements.get('notificationShowAll').click();
assert.equal(shared.elements.get('notificationList').children.length, 1, 'unrelated active warnings remain available');
const saved = JSON.parse(shared.storage.get('remotelab.notifications:/:person-a:delivery-read'));
assert.equal(saved['delivery-b'], 'version-b', 'store only read versions, not copies of delivery data');
console.log('test-chat-action-notifications: ok');
