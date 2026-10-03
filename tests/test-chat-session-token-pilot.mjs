import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../static/chat/session-token-pilot.js', import.meta.url), 'utf8');

function makeView(personId, usage, initialTheme = 'amber') {
  const titleRow = {
    children: [{ className: 'session-item-name' }, { className: 'session-item-actions' }],
    querySelector(selector) {
      return this.children.find((child) => child.className === selector.slice(1)) || null;
    },
    insertBefore(child, before) {
      this.children.splice(this.children.indexOf(before), 0, child);
    },
  };
  const row = {
    querySelector(selector) {
      if (selector === '.session-action-btn[data-id]') return { dataset: { id: 'session-one' } };
      if (selector === '.session-item-title-row') return titleRow;
      return null;
    },
  };
  const list = { querySelectorAll: () => [row] };
  const classes = [];
  const windowEvents = {};
  let theme = initialTheme;
  let fetchCount = 0;
  const context = {
    bootstrapAuthInfo: { person: { id: personId } },
    document: {
      documentElement: { classList: { add: (value) => classes.push(value) },
        getAttribute: () => theme },
      getElementById: () => list,
      createElement: () => ({ className: '', textContent: '', title: '', setAttribute() {} }),
      addEventListener() {},
      hidden: false,
    },
    window: { setInterval() {}, addEventListener: (name, listener) => { windowEvents[name] = listener; } },
    MutationObserver: class { observe() {} disconnect() {} },
    queueMicrotask,
    fetch: async () => {
      fetchCount++;
      return { ok: true, json: async () => ({ bySession: usage }) };
    },
  };
  runInNewContext(source, context);
  return { titleRow, classes, fetchCount: () => fetchCount,
    setTheme(value) { theme = value; windowEvents['remotelab:themechange']?.(); } };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('Session Token usage is available to another authenticated Person on Amber', async () => {
  const other = makeView('person_default', [
    { sessionId: 'session-one', runCount: 1, totalTokens: 2_500 },
  ]);
  await settle();
  assert.equal(other.fetchCount(), 1);
  assert.deepEqual(other.classes, ['session-token-pilot-enabled']);
  assert.equal(other.titleRow.children[1].textContent, '2.5k');
});

test('compact k amount sits between the title and action buttons', async () => {
  const view = makeView('person_8b536b37317e491d96036fc8', [
    { sessionId: 'session-one', runCount: 1, totalTokens: 12_400 },
  ]);
  await settle();
  assert.equal(view.fetchCount(), 1);
  assert.deepEqual(view.classes, ['session-token-pilot-enabled']);
  assert.deepEqual(view.titleRow.children.map((child) => child.className),
    ['session-item-name', 'session-token-pilot', 'session-item-actions']);
  assert.equal(view.titleRow.children[1].textContent, '12.4k');
  assert.match(view.titleRow.children[1].title, /12,400 Token/);
});

test('large recorded totals remain in k and missing records stay blank', async () => {
  const large = makeView('person_8b536b37317e491d96036fc8', [
    { sessionId: 'session-one', runCount: 3, totalTokens: 893_316_469 },
  ]);
  const missing = makeView('person_8b536b37317e491d96036fc8', []);
  await settle();
  assert.equal(large.titleRow.children[1].textContent, '893316k');
  assert.equal(missing.titleRow.children.length, 2);
});

test('Session Token usage waits for Amber and loads after theme change', async () => {
  const view = makeView('person_default', [
    { sessionId: 'session-one', runCount: 1, totalTokens: 8_700 },
  ], 'light');
  await settle();
  assert.equal(view.fetchCount(), 0);
  assert.equal(view.titleRow.children.length, 2);
  view.setTheme('amber');
  await settle();
  assert.equal(view.fetchCount(), 1);
  assert.equal(view.titleRow.children[1].textContent, '8.7k');
});
