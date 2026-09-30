import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../static/chat/session-token-pilot.js', import.meta.url), 'utf8');

function element(className = '') {
  return {
    className, children: [], dataset: {}, textContent: '', title: '',
    append(...children) { this.children.push(...children); },
    setAttribute() {},
    querySelectorAll(selector) {
      return selector === '.session-item' ? this.children.filter((child) => child.className === 'session-item') : [];
    },
    querySelector(selector) {
      if (selector === '.session-item-info') return this.children.find((child) => child.className === 'session-item-info') || null;
      if (selector === '.session-action-btn[data-id]') return this.children.find((child) => child.dataset.id) || null;
      if (selector === '.session-item-description, .session-item-meta') return this.children.find((child) => child.className === 'session-item-description') || null;
      if (selector === '.session-token-pilot') return this.children.find((child) => child.className.startsWith('session-token-pilot')) || null;
      if (selector === '.session-token-pilot-label') return this.children.find((child) => child.className === 'session-token-pilot-label') || null;
      return null;
    },
  };
}

function makeView(personId, usage) {
  const list = element();
  const row = element('session-item');
  const info = element('session-item-info');
  const description = element('session-item-description');
  const action = element('session-action-btn');
  action.dataset.id = 'session-one';
  info.append(description);
  row.append(info, action);
  list.append(row);
  let fetchCount = 0;
  runInNewContext(source, {
    bootstrapAuthInfo: { person: { id: personId } },
    document: { hidden: false, getElementById: () => list, createElement: () => element(), addEventListener() {} },
    window: { setInterval() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    queueMicrotask,
    fetch: async () => {
      fetchCount++;
      return { ok: true, json: async () => ({ bySession: usage }) };
    },
    Date, Number, Map,
  });
  return { row, description, fetchCount: () => fetchCount };
}

test('per-Session usage pilot stays invisible for other People', async () => {
  const view = makeView('person_other', [{ sessionId: 'session-one', runCount: 1, totalTokens: 1300000 }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(view.fetchCount(), 0);
  assert.equal(view.description.children.length, 0);
  assert.equal(view.row.dataset.tokenHeat, undefined);
});

test('pilot renders recorded usage with a heat level for Zhang Siyuan', async () => {
  const view = makeView('person_8b536b37317e491d96036fc8',
    [{ sessionId: 'session-one', runCount: 1, totalTokens: 1300000 }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(view.fetchCount(), 1);
  assert.equal(view.description.children.length, 0);
  assert.equal(view.row.dataset.tokenHeat, '3');
  assert.match(view.row.title, /已记录 Token：1,300,000/);
});

test('missing records are not displayed as zero usage', async () => {
  const view = makeView('person_8b536b37317e491d96036fc8', []);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(view.row.dataset.tokenHeat, undefined);
  assert.match(view.row.title, /暂无可核对/);
});
