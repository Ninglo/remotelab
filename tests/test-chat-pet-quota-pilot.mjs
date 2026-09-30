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

function renderForPerson(personId, getPayload) {
  const workspace = element();
  const document = {
    hidden: false,
    documentElement: { lang: 'zh-CN' },
    getElementById: () => workspace,
    createElement: element,
    addEventListener() {},
  };
  let fetchCount = 0;
  runInNewContext(source, {
    bootstrapAuthInfo: { person: { id: personId } },
    document,
    window: { setInterval() {} },
    fetch: async (url) => {
      fetchCount++;
      return { ok: true, json: async () => getPayload(url) };
    },
    Date,
    Number,
    Promise,
  });
  return { workspace, fetchCount: () => fetchCount };
}

test('quota pilot is not created for other People', () => {
  const view = renderForPerson('person_other', () => ({}));
  assert.equal(view.workspace.children.length, 0);
  assert.equal(view.fetchCount(), 0);
});

test('pilot shows fresh weekly remaining quota for the same Codex account', async () => {
  const revision = 'same-account';
  const view = renderForPerson('person_8b536b37317e491d96036fc8', (url) =>
    url.endsWith('/status')
      ? { codexAuth: { loggedIn: true, accountRevision: revision } }
      : { codexUsage: { status: 'ready', accountRevision: revision, checkedAt: new Date().toISOString(),
        buckets: [{ primary: { remainingPercent: 67.4, windowDurationMins: 10080,
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
        buckets: [{ primary: { remainingPercent: 90, windowDurationMins: 10080 } }] } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(view.workspace.children[0].children[0].textContent, '本周额度 · 暂不可用');
});
