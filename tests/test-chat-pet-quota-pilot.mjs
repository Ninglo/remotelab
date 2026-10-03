import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../static/chat/pet-quota-pilot.js', import.meta.url), 'utf8');

function element() {
  return {
    children: [], attributes: {}, hidden: false, textContent: '',
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, listener) { this[`on${name}`] = listener; },
  };
}

function renderForPerson(personId, getPayload, initialTheme = 'amber') {
  const workspace = element();
  let theme = initialTheme;
  const windowEvents = {};
  const document = {
    hidden: false,
    documentElement: { lang: 'zh-CN', getAttribute: () => theme },
    getElementById: () => workspace,
    createElement: element,
    addEventListener() {},
  };
  let fetchCount = 0;
  runInNewContext(source, {
    bootstrapAuthInfo: { person: { id: personId } },
    document,
    window: { setInterval() {}, addEventListener: (name, listener) => { windowEvents[name] = listener; } },
    fetch: async (url) => {
      fetchCount++;
      return { ok: true, json: async () => getPayload(url) };
    },
    Date,
    Number,
    Promise,
  });
  return { workspace, fetchCount: () => fetchCount,
    setTheme(value) { theme = value; windowEvents['remotelab:themechange']?.(); } };
}

test('Amber quota is available to another authenticated Person', async () => {
  const view = renderForPerson('person_other', () => ({}));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(view.workspace.children.length, 1);
  assert.equal(view.fetchCount(), 2);
});

test('pilot shows fresh weekly remaining quota for the same Codex account', async () => {
  const revision = 'same-account';
  const view = renderForPerson('person_8b536b37317e491d96036fc8', (url) =>
    url.endsWith('/status')
      ? { codexAuth: { loggedIn: true, accountRevision: revision } }
      : { codexUsage: { status: 'ready', accountRevision: revision, checkedAt: new Date().toISOString(),
        buckets: [{ id: 'codex', primary: { remainingPercent: 67.4, windowDurationMins: 10080,
          resetsAt: new Date(Date.now() + 86400000).toISOString() } }] } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(view.workspace.children.length, 1);
  assert.equal(view.workspace.children[0].children[0].textContent, '本周剩余 67.4%');
  assert.equal(view.fetchCount(), 2);
});

test('pilot hides quota from an account mismatch', async () => {
  const view = renderForPerson('person_8b536b37317e491d96036fc8', (url) =>
    url.endsWith('/status')
      ? { codexAuth: { loggedIn: true, accountRevision: 'new' } }
      : { codexUsage: { status: 'ready', accountRevision: 'old', checkedAt: new Date().toISOString(),
        buckets: [{ id: 'codex', primary: { remainingPercent: 90, windowDurationMins: 10080 } }] } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(view.workspace.children[0].children[0].textContent, '本周额度 · 暂不可用');
});

test('quota data loads only while Amber is selected for any Person', async () => {
  const revision = 'same-account';
  const view = renderForPerson('person_other', (url) =>
    url.endsWith('/status')
      ? { codexAuth: { loggedIn: true, accountRevision: revision } }
      : { codexUsage: { status: 'ready', accountRevision: revision, checkedAt: new Date().toISOString(),
        buckets: [{ id: 'codex', primary: { remainingPercent: 67.4, windowDurationMins: 10080,
          resetsAt: new Date(Date.now() + 86400000).toISOString() } }] } }, 'light');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(view.fetchCount(), 0);
  view.setTheme('amber');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(view.fetchCount(), 2);
  view.setTheme('light');
  assert.equal(view.workspace.children[0].children[1].hidden, true);
});

test('Amber shows Codex quota when a full model reserve arrives in either order', async () => {
  const revision = 'same-account';
  const codex = { id: 'codex', primary: { remainingPercent: 73, windowDurationMins: 10080 } };
  const reserve = { id: 'base_model_inference', name: 'gpt-reserve',
    primary: { remainingPercent: 100, windowDurationMins: 10080 } };
  for (const buckets of [[reserve, codex], [codex, reserve]]) {
    const view = renderForPerson('person_other', (url) => url.endsWith('/status')
      ? { codexAuth: { loggedIn: true, accountRevision: revision } }
      : { codexUsage: { status: 'ready', accountRevision: revision,
        checkedAt: new Date().toISOString(), buckets } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(view.workspace.children[0].children[0].textContent, '本周剩余 73%');
    const details = view.workspace.children[0].children[1].children.map(row => row.textContent);
    assert.equal(details.some(text => text.includes('100%')), false);
  }
});

test('Amber does not substitute a model reserve when Codex quota is unavailable', async () => {
  const revision = 'same-account';
  const view = renderForPerson('person_other', (url) => url.endsWith('/status')
    ? { codexAuth: { loggedIn: true, accountRevision: revision } }
    : { codexUsage: { status: 'ready', accountRevision: revision,
      checkedAt: new Date().toISOString(), buckets: [{ id: 'base_model_inference',
        primary: { remainingPercent: 100, windowDurationMins: 10080 } }] } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(view.workspace.children[0].children[0].textContent, '本周额度 · 暂不可用');
});
