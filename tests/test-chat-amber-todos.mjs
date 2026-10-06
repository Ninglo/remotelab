import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../static/chat/amber-todos.js', import.meta.url), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));
function element(tag = 'div') {
  return {
    tag, children: [], attributes: {}, dataset: {}, hidden: false, textContent: '',
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, listener) { this[`on${name}`] = listener; },
    contains(item) { return item === this || this.children.some((child) => child.contains(item)); },
    focus() { this.focused = true; }, querySelector() { return null; },
  };
}
function fixture({ theme = 'amber', person = true, fetcher } = {}) {
  const host = element();
  const events = {};
  const calls = [];
  const document = { hidden: false, documentElement: { lang: 'zh-CN', getAttribute: () => theme },
    querySelector: () => host, createElement: element,
    addEventListener: (name, listener) => { events[name] = listener; } };
  runInNewContext(source, {
    bootstrapAuthInfo: person ? { person: { id: 'person_test' } } : null,
    document, window: { addEventListener: (name, listener) => { events[name] = listener; },
      remotelabResolveProductPath: (value) => `/lab${value}` },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return fetcher ? fetcher(url, options) : response({ items: tasks });
    },
    Date, Number, Promise, encodeURIComponent,
  });
  const root = host.children[0];
  const [toggle, panel] = root?.children || [];
  const [header, message, list] = panel?.children || [];
  return { host, toggle, panel, message, list, calls, events, refresh: header?.children[1],
    setTheme(value) { theme = value; events['remotelab:themechange']?.(); },
    check() { return list.children[0].children[0]; } };
}
const tasks = [
  { id: 'todo_1111111111111111', title: '<script>unsafe</script>', note: 'The actual task detail', status: 'blocked', dueAt: null },
  { id: 'todo_2222222222222222', title: 'Already done', status: 'done', dueAt: null },
];
const response = (payload, ok = true) => ({ ok, json: async () => payload });

test('only Amber with an authenticated Person reads the personal task endpoint', async () => {
  const view = fixture({ theme: 'light' });
  await tick();
  assert.equal(view.calls.length, 0);
  view.setTheme('amber');
  await tick();
  assert.equal(view.calls[0].url, '/lab/api/display/todos');
  assert.equal(view.calls[0].options.credentials, 'same-origin');
  assert.equal(view.toggle.textContent, 'To do · 1');
  assert.equal(fixture({ person: false }).host.children.length, 0);
});

test('opening refreshes the list, renders text safely, and Escape returns focus', async () => {
  const view = fixture();
  await tick();
  assert.equal(view.panel.hidden, true);
  view.toggle.onclick();
  await tick();
  assert.equal(view.calls.length, 2);
  assert.equal(view.panel.hidden, false);
  assert.equal(view.toggle.attributes['aria-expanded'], 'true');
  const detail = view.list.children[0].children[1].children[0];
  assert.equal(detail.children[0].textContent, tasks[0].title);
  assert.equal(detail.children[1].textContent, tasks[0].note);
  assert.equal(view.list.children[1].tag, 'details');
  view.events.keydown({ key: 'Escape', preventDefault() {} });
  assert.equal(view.panel.hidden, true);
  assert.equal(view.toggle.focused, true);
});

test('completion writes only status to the same endpoint and updates the open count', async () => {
  const view = fixture({ fetcher: (url, options) => options.method === 'PATCH'
    ? response({ item: { ...tasks[0], status: 'done' } }) : response({ items: tasks }) });
  await tick();
  const checkbox = view.check();
  checkbox.checked = true;
  checkbox.onchange();
  await tick();
  const write = view.calls.at(-1);
  assert.equal(write.url, '/lab/api/display/todos/todo_1111111111111111');
  assert.deepEqual(JSON.parse(write.options.body), { status: 'done' });
  assert.equal(view.toggle.textContent, 'To do · 0');
  assert.equal(view.list.children[0].tag, 'details');
});

test('failed completion preserves the original task and exposes an error', async () => {
  const view = fixture({ fetcher: (url, options) => options.method === 'PATCH'
    ? response({}, false) : response({ items: tasks }) });
  await tick();
  const checkbox = view.check();
  checkbox.checked = true;
  checkbox.onchange();
  await tick();
  assert.equal(view.toggle.textContent, 'To do · 1');
  assert.equal(view.check().checked, false);
  assert.equal(view.list.children[0].dataset.status, 'blocked');
  assert.match(view.message.textContent, /更新失败/);
});

test('late reads cannot undo a completed write', async () => {
  let resolveRead;
  let reads = 0;
  const view = fixture({ fetcher: (url, options) => {
    if (options.method === 'PATCH') return response({ item: { ...tasks[0], status: 'done' } });
    if (++reads === 1) return response({ items: tasks });
    return new Promise((resolve) => { resolveRead = resolve; });
  } });
  await tick();
  view.toggle.onclick();
  const checkbox = view.check();
  checkbox.checked = true;
  checkbox.onchange();
  await tick();
  resolveRead(response({ items: tasks }));
  await tick();
  assert.equal(view.toggle.textContent, 'To do · 0');
});

test('switching away closes the panel and discards an in-flight response', async () => {
  let resolveRead;
  const view = fixture({ fetcher: () => new Promise((resolve) => { resolveRead = resolve; }) });
  view.toggle.onclick();
  view.setTheme('light');
  resolveRead(response({ items: tasks }));
  await tick();
  assert.equal(view.panel.hidden, true);
  assert.equal(view.toggle.textContent, 'To do');
});

test('a failed read offers retry and a later successful read clears the error', async () => {
  let failed = true;
  const view = fixture({ fetcher: () => response(failed ? {} : { items: [] }, !failed) });
  await tick();
  assert.match(view.message.textContent, /无法读取/);
  failed = false;
  view.refresh.onclick();
  await tick();
  assert.equal(view.toggle.textContent, 'To do · 0');
  assert.match(view.message.textContent, /还没有待办/);
});
