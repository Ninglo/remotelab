#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../static/chat/settings-ui.js', import.meta.url), 'utf8');
const snippet = source.slice(
  source.indexOf('let pushNotificationPermissionPending ='),
  source.indexOf('function renderInstallSettingsPanel()'),
);
const template = await readFile(new URL('../templates/chat.html', import.meta.url), 'utf8');
assert.match(template, /id="settingsPushEnableBtn"[^>]*type="button"/);
assert.match(template, /id="settingsPushStatus"[^>]*role="status"/);
assert.match(source, /initPushNotificationSettings\(\);/);
assert.match(source, /"remotelab:pushstatechange", renderPushNotificationSettings/);

function createHarness({ permission = 'default', response = 'granted', supported = true, owner = true, result = 'subscribed', requestError = null } = {}) {
  const elements = new Map(['settingsPushSection', 'settingsPushEnableBtn', 'settingsPushStatus'].map((id) => [id, {
    dataset: {}, listeners: [], disabled: false, hidden: false, textContent: '',
    addEventListener(type, callback) { this.listeners.push({ type, callback }); },
  }]));
  const calls = [];
  let state = { status: 'idle', error: '' };
  let resolvePermission;
  const notification = {
    permission,
    requestPermission() {
      calls.push('permission');
      if (requestError) return Promise.reject(requestError);
      return new Promise((resolve) => { resolvePermission = () => { notification.permission = response; resolve(response); }; });
    },
  };
  const context = {
    document: { getElementById: (id) => elements.get(id) },
    window: supported ? { Notification: notification, PushManager: function () {}, isSecureContext: true } : {},
    navigator: supported ? { serviceWorker: {} } : {},
    Notification: notification,
    isOwnerPushFeatureEnabled: () => owner,
    getPushNotificationSetupState: () => state,
    async setupPushNotifications() {
      calls.push('setup');
      state = { status: 'registering', error: '' };
      context.renderPushNotificationSettings();
      await Promise.resolve();
      state = { status: result, error: result === 'failed' ? 'HTTP 500' : '' };
      return state;
    },
    t: (key, values = {}) => `${key}${values.error ? `: ${values.error}` : ''}`,
  };
  vm.createContext(context);
  vm.runInContext(snippet, context);
  context.initPushNotificationSettings();
  return {
    context, calls, notification,
    section: elements.get('settingsPushSection'),
    button: elements.get('settingsPushEnableBtn'),
    status: elements.get('settingsPushStatus'),
    resolvePermission: () => resolvePermission(),
    click: () => elements.get('settingsPushEnableBtn').listeners[0].callback(),
  };
}

const fresh = createHarness();
assert.equal(fresh.section.hidden, false);
assert.equal(fresh.status.textContent, 'settings.push.statusDefault');
assert.equal(fresh.button.disabled, false);
assert.equal(fresh.button.textContent, 'settings.push.enable');
assert.deepEqual(fresh.calls, [], 'rendering settings must not prompt automatically');
fresh.context.initPushNotificationSettings();
assert.equal(fresh.button.listeners.length, 1, 'only one click handler is bound');
const enabling = fresh.click();
assert.deepEqual(fresh.calls, ['permission'], 'requestPermission must run synchronously within the click, before setup or any await');
assert.equal(fresh.button.disabled, true);
assert.equal(fresh.status.textContent, 'settings.push.statusRequesting');
await fresh.click();
assert.deepEqual(fresh.calls, ['permission'], 'a pending prompt must not be duplicated');
fresh.resolvePermission();
await enabling;
assert.deepEqual(fresh.calls, ['permission', 'setup']);
assert.equal(fresh.status.textContent, 'settings.push.statusSubscribed');
assert.equal(fresh.button.disabled, false);
assert.equal(fresh.button.textContent, 'settings.push.reconnect');
await fresh.click();
assert.deepEqual(fresh.calls, ['permission', 'setup', 'setup'], 'reconnect reuses granted permission without another prompt');

for (const response of ['denied', 'default']) {
  const harness = createHarness({ response });
  const pending = harness.click();
  harness.resolvePermission();
  await pending;
  assert.deepEqual(harness.calls, ['permission'], 'denial/dismissal must not create a push subscription');
  assert.equal(harness.status.textContent, response === 'denied' ? 'settings.push.statusDenied' : 'settings.push.statusDefault');
  assert.equal(harness.button.disabled, response === 'denied');
}

const granted = createHarness({ permission: 'granted' });
assert.equal(granted.status.textContent, 'settings.push.statusGranted', 'permission alone is not a confirmed subscription');
await granted.click();
assert.deepEqual(granted.calls, ['setup']);
assert.equal(granted.status.textContent, 'settings.push.statusSubscribed');

const failed = createHarness({ permission: 'granted', result: 'failed' });
await failed.click();
assert.equal(failed.status.textContent, 'settings.push.statusFailed: HTTP 500');
assert.equal(failed.button.disabled, false, 'a failed save can be retried');

const promptFailure = createHarness({ requestError: new Error('Permission prompt unavailable') });
await promptFailure.click();
assert.equal(promptFailure.status.textContent, 'settings.push.statusFailed: Permission prompt unavailable');
assert.equal(promptFailure.button.disabled, false);

const blocked = createHarness({ permission: 'denied' });
assert.equal(blocked.status.textContent, 'settings.push.statusDenied');
assert.equal(blocked.button.disabled, true);
blocked.notification.permission = 'granted';
blocked.context.renderPushNotificationSettings();
assert.equal(blocked.button.disabled, false, 'returning after changing browser settings offers reconnect');
assert.equal(blocked.status.textContent, 'settings.push.statusGranted');

const unsupported = createHarness({ supported: false });
assert.equal(unsupported.status.textContent, 'settings.push.statusUnsupported');
assert.equal(unsupported.button.disabled, true);
await unsupported.click();
assert.deepEqual(unsupported.calls, []);
const scoped = createHarness({ owner: false });
assert.equal(scoped.section.hidden, true);
await scoped.click();
assert.deepEqual(scoped.calls, [], 'visitors and agent-scoped surfaces cannot activate owner notifications');

console.log('test-push-notification-settings: ok');
