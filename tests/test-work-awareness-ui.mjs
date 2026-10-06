import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

let panel, fillEvents = 0, posts = 0;
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.textContent = ''; }
  appendChild(child) { this.children.push(child); return child; }
  addEventListener(event, fn) { this.listeners[event] = fn; }
  replaceWith(next) { panel = next; }
  remove() { panel = undefined; }
  querySelector() { return this.children.find(child => child.tag === 'summary'); }
}
const fixture = { related: [{ sessionId: 'b', goal: '同一份开工资料', status: 'active', actor: { name: '乙' } }],
  suggestions: [{ id: 'suggestion_1', sourceSessionId: 'a', targetSessionId: 'b', state: 'draft', content: '参考建议', impact: '核对重叠' }] };
let data = fixture, pendingQuestion = false, delay;
const source = await readFile(new URL('../static/chat/session-surface-ui.js', import.meta.url), 'utf8');
const context = vm.createContext({ URLSearchParams, Event, currentSessionId: 'a', shareSnapshotMode: false,
  queuedPanel: { after(next) { panel = next; } },
  msgInput: { value: '', dispatchEvent() { fillEvents++; }, focus() {} },
  document: { getElementById() { return panel; }, createElement(tag) { return new Element(tag); },
    createTextNode(text) { return { textContent: text }; }, querySelector() { return pendingQuestion; } },
  async fetch(url, options) { if (options?.method === 'POST') posts++; if (delay) await delay;
    assert.match(url, /includeBackground=false/); return { ok: true, async json() { return data; } }; },
});
vm.runInContext(source, context);
const session = { id: 'a', workAwareness: { revision: 1, intents: [{ goal: '开工资料' }] } };
await context.renderWorkAwarenessPanel(session);
assert.match(panel.querySelector().textContent, /相关工作与参考建议/);
const control = panel.children.find(child => child.tag === 'button');
control.listeners.click();
assert.match(context.msgInput.value, /确认协作建议 suggestion_1 发布/);
assert.equal(posts, 0, 'the control only prepares a human draft'); assert.equal(fillEvents, 1);
context.msgInput.value = '人自己的草稿'; control.listeners.click(); assert.equal(context.msgInput.value, '人自己的草稿');
data = { related: [], suggestions: [{ ...fixture.suggestions[0], state: 'published' }] };
context.currentSessionId = 'b';
await context.renderWorkAwarenessPanel({ ...session, id: 'b' });
assert.match(panel.children.find(child => child.tag === 'button').title, /执行/);
pendingQuestion = true;
await context.renderWorkAwarenessPanel({ ...session, id: 'b' });
assert.equal(panel.children.some(child => child.tag === 'button'), false, 'confirmation is not offered as a pending-question answer');
let release; delay = new Promise(resolve => { release = resolve; });
const old = context.renderWorkAwarenessPanel({ ...session, id: 'b' });
context.currentSessionId = 'c'; await context.renderWorkAwarenessPanel({ id: 'c' }); release(); await old;
assert.equal(panel, undefined, 'late response cannot repopulate another Session');
console.log('WORK_UI_VERIFIED: symmetric references are visible; source publication and target adoption remain separate human drafts; no auto-send or draft overwrite; pending questions and stale responses protected.');
