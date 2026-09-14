#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const template = await readFile(new URL('../templates/mobile-install.html', import.meta.url), 'utf8');
const head = template.match(/<head>([\s\S]*?)<\/head>/)?.[1] || '';
const launchScript = head.match(/<script nonce="\{\{NONCE\}\}">([\s\S]*?)<\/script>/)?.[1];
assert.ok(launchScript, 'legacy installed icons need a nonce-protected pre-paint launch guard');
assert.ok(head.indexOf('<base ') < head.indexOf('<script '), 'launch must resolve the forwarded product prefix');
assert.ok(head.indexOf('<script ') < head.indexOf('<link '), 'launch must not wait for linked assets');
assert.doesNotMatch(template, /redeemLoading|continueStandaloneLaunch/, 'installed apps must never show setup/redirect copy');

function launch({ standalone = false, ios = false, matchMedia = true, prefix = '/', token = 'ih_' + 'a'.repeat(48) } = {}) {
  const calls = [];
  const root = { style: {} };
  const window = {
    location: {
      href: `https://example.test${prefix}m/install${token ? `?h=${encodeURIComponent(token)}` : ''}`,
      replace(url) { calls.push(url); },
    },
    ...(matchMedia ? { matchMedia: (query) => ({ matches: standalone && query === '(display-mode: standalone)' }) } : {}),
  };
  const navigator = { standalone: ios };
  // Storage sharing and SW readiness must not participate in installed launch routing.
  Object.defineProperty(navigator, 'serviceWorker', { get() { throw new Error('must not touch service worker'); } });
  vm.runInNewContext(launchScript, {
    window,
    navigator,
    document: { baseURI: `https://example.test${prefix}`, documentElement: root },
    URL,
  });
  return { calls, visibility: root.style.visibility };
}

for (const prefix of ['/', '/owner/']) {
  for (const mode of [{ standalone: true }, { ios: true }, { ios: true, matchMedia: false }]) {
    for (const token of ['ih_' + 'a'.repeat(48), '', 'invalid&next=https://other.test/']) {
      const result = launch({ ...mode, prefix, token });
      const expected = new URL(`https://example.test${prefix}m/continue`);
      if (token) expected.searchParams.set('h', token);
      assert.deepEqual(result.calls, [expected.href], 'legacy cold launch should go straight to the same-origin HTTP bridge');
      assert.equal(result.visibility, 'hidden', 'legacy install guide must not flash before navigation');
      assert.deepEqual(launch({ ...mode, prefix, token }), result, 'relaunch must not depend on a remembered installation flag');
    }
  }
  for (const matchMedia of [true, false]) {
    const browser = launch({ prefix, matchMedia });
    assert.deepEqual(browser.calls, [], 'ordinary browser visits must retain the install guide');
    assert.equal(browser.visibility, undefined, 'browser guide must remain visible');
  }
}
console.log('PASS mobile install pre-paint launch routing (iOS, Android, browser, prefix, repeat launch)');
