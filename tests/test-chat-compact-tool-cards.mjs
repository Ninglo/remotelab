import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const chatTemplate = readFileSync(new URL('../templates/chat.html', import.meta.url), 'utf8');
assert.match(chatTemplate, /src="chat\/activity-ui\.js\?v=\{\{ASSET_VERSION\}\}" nonce="\{\{NONCE\}\}"/, 'the real chat entry must load activity renderers, not just the fallback loader');
assert(chatTemplate.indexOf('chat/activity-ui.js') < chatTemplate.indexOf('chat/init.js'), 'activity renderers must load before initialization');
class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {};
    this.className = ''; this.textContent = ''; this.listeners = {};
    this.classList = {
      contains: token => this.className.split(' ').includes(token),
      add: (...tokens) => { this.className += ' ' + tokens.join(' '); },
      toggle: (token, on) => { this.className = this.className.split(' ').filter(x => x !== token).join(' '); if (on) this.className += ' ' + token; },
    };
  }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.append(node); return node; }
  insertBefore(node, before) { this.children.splice(this.children.indexOf(before), 0, node); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(key, fn) { this.listeners[key] = fn; }
  querySelectorAll(selector) {
    const names = selector.slice(1).split('.');
    return this.children.flatMap(node => [
      ...(names.every(n => node.classList.contains(n)) ? [node] : []), ...node.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
const context = vm.createContext({
  document: { createElement: tag => new Element(tag) },
  window: { remotelabT: key => key }, hydrateLazyNodes: async () => {},
});
vm.runInContext(readFileSync(new URL('../static/chat/ui.js', import.meta.url), 'utf8'), context);
vm.runInContext(readFileSync(new URL('../static/chat/activity-ui.js', import.meta.url), 'utf8'), context);
const root = new Element('div');
const use = (id, command = 'npm test', runId = 'run1') => context.renderToolUseInto(root, {
  type: 'tool_use', toolCallId: id, toolName: 'bash', toolInput: command, runId,
});
const result = (id, output = 'ok', runId = 'run1') => context.renderToolResultInto(root, {
  type: 'tool_result', toolCallId: id, toolName: 'bash', output, exitCode: 0, runId,
});
const a = use('a'); const b = use('b');
use('a'); result('a', 'first');
assert.equal(root.children.length, 2, 'start/update/completion echoes share one row');
assert.equal(a.classList.contains('is-running'), false);
assert.equal(b.classList.contains('is-running'), true, 'parallel identical commands remain independent');
assert.equal(a.querySelector('.activity-output').textContent, 'first');
assert.equal(a.querySelector('.activity-input').hidden, true);
a.querySelector('.activity-tabs').children[1].listeners.click();
assert.equal(a.querySelector('.activity-input').hidden, false, 'full input remains accessible');
result('a', 'first');
assert.equal(a.querySelector('.activity-input').hidden, false, 'updates preserve selected tab');
result('a', 'updated output');
assert.equal(a.querySelector('.activity-output').textContent, 'updated output');
result('b'); use('a', 'npm test', 'run2');
assert.equal(root.children.length, 3, 'IDs are scoped per run');
result('missing', 'orphan');
assert.equal(root.children.length, 4, 'orphan results remain visible');
const legacy = new Element('div');
const old = { toolName: 'bash', toolInput: 'npm test' };
context.renderToolUseInto(legacy, old); context.renderToolUseInto(legacy, old);
context.renderToolResultInto(legacy, { toolName: 'bash', output: 'ok', exitCode: 0 });
assert.equal(legacy.children.length, 1, 'old histories collapse pending echoes');
context.renderToolUseInto(legacy, old);
assert.equal(legacy.children.length, 2, 'later repeated commands remain separate');
context.settleActivityTools(legacy);
assert.equal(legacy.querySelectorAll('.is-running').length, 0);
assert.equal(legacy.children[1].querySelector('.activity-meta').textContent, 'activity.unconfirmed');
const files = new Element('div');
context.renderFileChangeInto(files, { filePath: '/tmp/a.js', changeType: 'edit', diff: '@@ -1 +1 @@\n-old\n+<script>safe</script>' });
assert.equal(files.querySelector('.diff-add').textContent, '+<script>safe</script>\n');
assert.equal(files.querySelector('.activity-meta').textContent, '+1 −1');
context.renderFileChangeInto(files, { filePath: '/tmp/b.js' });
assert.equal(files.children[1].querySelector('.activity-empty').textContent, 'activity.noDiff');
assert.equal(context.summarizeToolInput('{"cmd":"npm test"}'), 'npm test');
console.log('test-chat-compact-tool-cards: lifecycle, concurrency, legacy, disclosure and diffs passed');
