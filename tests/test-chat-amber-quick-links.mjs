import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../static/chat/amber-quick-links.js', import.meta.url), 'utf8');
function element() {
  return { children: [], attributes: {}, hidden: false,
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; },
    setAttribute(name, value) { this.attributes[name] = value; } };
}
function fixture(personId = 'first') {
  const host = element();
  const window = { addEventListener() {} };
  let people = [
    { id: 'first', preferences: { quickLinks: [{ label: '工作文档', url: 'https://example.com/docs' }] } },
    { id: 'second', preferences: { quickLinks: [{ label: 'Other directory', url: 'https://example.org/' }] } },
  ];
  runInNewContext(source, { URL, window,
    bootstrapAuthInfo: personId ? { person: { id: personId } } : null,
    getPeopleDirectory: () => people,
    document: { documentElement: { lang: 'zh-CN' }, querySelector: () => host, createElement: element } });
  return { host, root: host.children[0],
    update(value) { people = value; window.remotelabRefreshQuickLinks(); } };
}

test('each signed-in Person sees their own link with safe new-tab navigation', () => {
  const first = fixture();
  const link = first.root.children[0];
  assert.equal(first.root.children.length, 1);
  assert.equal(link.textContent, '工作文档');
  assert.equal(link.href, 'https://example.com/docs');
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer');
  assert.equal(fixture('second').root.children[0].href, 'https://example.org/');
  assert.equal(fixture(null).host.children.length, 0);
});

test('a directory update replaces old links and removal hides the entry', () => {
  const view = fixture();
  view.update([{ id: 'first', preferences: { quickLinks: [{ label: '新入口', url: 'https://example.com/new' }] } }]);
  assert.equal(view.root.children[0].href, 'https://example.com/new');
  view.update([{ id: 'first', preferences: { quickLinks: [] } }]);
  assert.equal(view.root.children.length, 0);
  assert.equal(view.root.hidden, true);
});

test('unsafe saved destinations are skipped and labels remain plain text', () => {
  const view = fixture();
  view.update([{ id: 'first', preferences: { quickLinks: [
    { label: 'unsafe', url: 'javascript:alert(1)' },
    { label: 'unsafe', url: 'data:text/html,hello' },
    { label: 'credentials', url: 'https://user:password@example.com/' },
    { label: '<img onerror=alert(1)>', url: 'https://example.com/safe' },
  ] } }]);
  assert.equal(view.root.children.length, 1);
  assert.equal(view.root.children[0].textContent, '<img onerror=alert(1)>');
});
