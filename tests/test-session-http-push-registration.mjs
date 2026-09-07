#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const sessionHttpSource = readFileSync(join(repoRoot, 'static/chat/session-http.js'), 'utf8');

const setupStart = sessionHttpSource.indexOf('let pushNotificationSetupState =');
if (setupStart === -1) throw new Error('Missing setupPushNotifications');
const setupSnippet = `${sessionHttpSource.slice(setupStart)}\nglobalThis.setupPushNotifications = setupPushNotifications;`;

function createHarness({ existingSubscription, permission = 'granted', saveStatus = 200, saveBody = { ok: true }, keyStatus = 200, registrationError = null, subscribeError = null, owner = true, supported = true, prefix = '', redirected = false } = {}) {
  const fetchCalls = [];
  const subscriptionPayload = { endpoint: existingSubscription ? 'https://push.example/existing' : 'https://push.example/new' };
  const subscribeCalls = [];
  const registration = {
    update() {
      return Promise.resolve();
    },
    installing: { postMessage() {} },
    waiting: { postMessage() {} },
    active: { postMessage() {} },
    pushManager: {
      getSubscription() {
        return Promise.resolve(existingSubscription
          ? {
              toJSON() {
                return subscriptionPayload;
              },
            }
          : null);
      },
      subscribe(options) {
        subscribeCalls.push(options);
        if (subscribeError) return Promise.reject(subscribeError);
        return Promise.resolve({
          toJSON() {
            return subscriptionPayload;
          },
        });
      },
    },
  };
  const events = [];
  const notification = { permission };
  const context = {
    console,
    Notification: notification,
    CustomEvent: class CustomEvent { constructor(type) { this.type = type; } },
    shouldEnableOwnerPushFeatures: () => owner,
    JSON,
    Promise,
    encodeURIComponent,
    buildAssetVersion: 'build-test',
    visitorMode: false,
    navigator: {
      serviceWorker: {
        register() {
          if (registrationError) return Promise.reject(registrationError);
          return Promise.resolve(registration);
        },
        ready: Promise.resolve(registration),
      },
    },
    window: {
      ...(supported ? { PushManager: function PushManager() {} } : {}),
      Notification: notification,
      dispatchEvent(event) { events.push(event.type); },
      remotelabResolveProductPath: (path) => `${prefix}${path}`,
    },
    fetch(url, options = {}) {
      fetchCalls.push({ url, options });
      if (url === `${prefix}/api/push/vapid-public-key`) {
        return Promise.resolve({
          ok: keyStatus === 200,
          status: keyStatus,
          json: async () => ({ publicKey: 'BEl6Y3Rlc3RLZXk' }),
        });
      }
      if (url === `${prefix}/api/push/subscribe`) {
        return Promise.resolve({ ok: saveStatus === 200, status: saveStatus, redirected, json: async () => saveBody });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
    urlBase64ToUint8Array(value) {
      return value;
    },
  };
  vm.runInNewContext(setupSnippet, context, { filename: 'setupPushNotifications.vm' });
  return {
    fetchCalls,
    subscribeCalls,
    events,
    setupPushNotifications: context.setupPushNotifications,
    getState: context.getPushNotificationSetupState,
  };
}

const existingHarness = createHarness({ existingSubscription: true });
assert.equal((await existingHarness.setupPushNotifications()).status, 'subscribed');
assert.equal(existingHarness.subscribeCalls.length, 0, 'existing subscriptions should not request a new browser subscription');
assert.equal(existingHarness.fetchCalls.length, 1, 'existing subscriptions should still sync back to the backend');
assert.equal(existingHarness.fetchCalls[0].url, '/api/push/subscribe');
assert.deepEqual(JSON.parse(existingHarness.fetchCalls[0].options.body), {
  endpoint: 'https://push.example/existing',
}, 'existing subscription sync should post the current subscription payload');

const freshHarness = createHarness({ existingSubscription: false });
assert.equal((await freshHarness.setupPushNotifications()).status, 'subscribed');
assert.equal(freshHarness.subscribeCalls.length, 1, 'missing subscriptions should request a new browser subscription');
assert.deepEqual(freshHarness.fetchCalls.map((entry) => entry.url), [
  '/api/push/vapid-public-key',
  '/api/push/subscribe',
], 'fresh subscriptions should fetch the VAPID key and persist the new subscription');
assert.deepEqual(JSON.parse(freshHarness.fetchCalls[1].options.body), {
  endpoint: 'https://push.example/new',
}, 'new subscription sync should post the subscribed payload');

assert.deepEqual(freshHarness.events, ['remotelab:pushstatechange', 'remotelab:pushstatechange']);

for (const options of [
  { saveStatus: 500 },
  { existingSubscription: true, saveStatus: 401 },
  { saveBody: { ok: false } },
  { saveBody: {} },
  { redirected: true },
  { keyStatus: 503 },
  { registrationError: new Error('SW registration failed') },
  { subscribeError: new Error('Push service unavailable') },
]) {
  const harness = createHarness(options);
  const result = await harness.setupPushNotifications();
  assert.equal(result.status, 'failed', `setup must surface failure for ${JSON.stringify(options)}`);
  assert.ok(result.error);
  assert.equal(harness.getState().status, 'failed');
}

for (const options of [
  { permission: 'default' },
  { permission: 'denied' },
  { owner: false },
  { supported: false },
]) {
  const harness = createHarness(options);
  assert.notEqual((await harness.setupPushNotifications()).status, 'subscribed');
  assert.equal(harness.fetchCalls.length, 0, 'ineligible setup must not fetch or ask permission');
  assert.equal(harness.subscribeCalls.length, 0);
}

const concurrent = createHarness();
await Promise.all([concurrent.setupPushNotifications(), concurrent.setupPushNotifications()]);
assert.equal(concurrent.subscribeCalls.length, 1, 'startup and enable must share one registration');
assert.equal(concurrent.fetchCalls.filter(({ url }) => url.endsWith('/subscribe')).length, 1);
await concurrent.setupPushNotifications();
assert.equal(concurrent.fetchCalls.filter(({ url }) => url.endsWith('/subscribe')).length, 2, 'reconnect can retry after settlement');

const prefixed = createHarness({ prefix: '/instance/example' });
assert.equal((await prefixed.setupPushNotifications()).status, 'subscribed');
assert.deepEqual(prefixed.fetchCalls.map(({ url }) => url), [
  '/instance/example/api/push/vapid-public-key', '/instance/example/api/push/subscribe',
]);

console.log('test-session-http-push-registration: ok');
