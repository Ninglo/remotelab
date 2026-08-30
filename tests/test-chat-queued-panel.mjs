#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

class FakeClassList {
  constructor(element) {
    this.element = element;
  }

  get values() {
    return new Set(String(this.element.className || '').split(/\s+/).filter(Boolean));
  }

  write(values) {
    this.element.className = [...values].join(' ');
  }

  add(...tokens) {
    const values = this.values;
    tokens.forEach((token) => values.add(token));
    this.write(values);
  }

  remove(...tokens) {
    const values = this.values;
    tokens.forEach((token) => values.delete(token));
    this.write(values);
  }

  contains(token) {
    return this.values.has(token);
  }

  toggle(token, force) {
    const values = this.values;
    const enabled = force === undefined ? !values.has(token) : Boolean(force);
    if (enabled) values.add(token);
    else values.delete(token);
    this.write(values);
    return enabled;
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName || '').toUpperCase();
    this.className = '';
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.hidden = false;
    this.textContent = '';
    this._innerHTML = '';
    this.classList = new FakeClassList(this);
  }

  set innerHTML(value) {
    this._innerHTML = String(value || '');
    if (!value) this.children = [];
  }

  get innerHTML() {
    return this._innerHTML;
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) || null;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  click() {
    for (const listener of this.listeners.get('click') || []) listener({ target: this });
  }
}

function findByClass(root, className) {
  if (root.classList?.contains(className)) return root;
  for (const child of root.children || []) {
    const match = findByClass(child, className);
    if (match) return match;
  }
  return null;
}

const source = await readFile(new URL('../static/chat/session-surface-ui.js', import.meta.url), 'utf8');
const queuedPanel = new FakeElement('div');
const translations = {
  'queue.single': '1 follow-up queued',
  'queue.multiple': ({ count }) => `${count} follow-ups queued`,
  'queue.expand': 'Expand queued follow-ups',
  'queue.collapse': 'Collapse queued follow-ups',
  'queue.note.afterRun': 'Will send automatically after the current run',
  'queue.note.preparing': 'Preparing the next turn',
  'queue.timestamp.default': 'Queued',
  'queue.timestamp.withTime': ({ time }) => `Queued ${time}`,
  'queue.attachmentOnly': '(attachment)',
  'queue.attachments': ({ names }) => `Attachments: ${names}`,
};
const translate = (key, vars = {}) => {
  const value = translations[key];
  return typeof value === 'function' ? value(vars) : (value || key);
};
const context = {
  console,
  currentSessionId: 'session-1',
  document: {
    createElement: (tagName) => new FakeElement(tagName),
  },
  getAttachmentDisplayName: (attachment) => attachment?.name || '',
  getSessionActivity: () => ({ run: { state: 'running' }, compact: { state: 'idle' } }),
  messageTimeFormatter: { format: () => '10:30' },
  queuedPanel,
  renderUiIcon: (name) => `<svg data-icon="${name}"></svg>`,
  window: { remotelabT: translate },
};
vm.runInNewContext(source, context, { filename: 'session-surface-ui.js' });

const session = {
  id: 'session-1',
  queuedMessages: [
    { queuedAt: '2026-08-30T10:30:00.000Z', text: 'A very long first follow-up' },
    { queuedAt: '2026-08-30T10:31:00.000Z', text: 'A very long second follow-up' },
  ],
};
context.renderQueuedMessagePanel(session);

let header = findByClass(queuedPanel, 'queued-panel-header');
let details = findByClass(queuedPanel, 'queued-panel-details');
assert.ok(queuedPanel.classList.contains('visible'), 'queue panel should be visible when follow-ups exist');
assert.equal(queuedPanel.classList.contains('expanded'), false, 'queue panel should default to summary-only');
assert.equal(header.getAttribute('aria-expanded'), 'false');
assert.equal(details.hidden, true, 'queued message bodies should be hidden by default');
assert.equal(findByClass(queuedPanel, 'queued-panel-title').children[1].textContent, '2 follow-ups queued');

header.click();
assert.ok(queuedPanel.classList.contains('expanded'), 'clicking the summary should expand queue details');
assert.equal(header.getAttribute('aria-expanded'), 'true');
assert.equal(details.hidden, false);
assert.equal(findByClass(details, 'queued-item-text').textContent, 'A very long first follow-up');

context.renderQueuedMessagePanel(session);
header = findByClass(queuedPanel, 'queued-panel-header');
details = findByClass(queuedPanel, 'queued-panel-details');
assert.ok(queuedPanel.classList.contains('expanded'), 'same-session refresh should preserve explicit expansion');
assert.equal(header.getAttribute('aria-expanded'), 'true');
assert.equal(details.hidden, false);

context.currentSessionId = 'session-2';
context.renderQueuedMessagePanel({ id: 'session-2', queuedMessages: [{ text: 'Another follow-up' }] });
header = findByClass(queuedPanel, 'queued-panel-header');
details = findByClass(queuedPanel, 'queued-panel-details');
assert.equal(queuedPanel.classList.contains('expanded'), false, 'a different session should return to collapsed-by-default');
assert.equal(header.getAttribute('aria-expanded'), 'false');
assert.equal(details.hidden, true);

console.log('test-chat-queued-panel: ok');
