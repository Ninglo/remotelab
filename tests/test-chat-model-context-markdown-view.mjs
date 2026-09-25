#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ui = readFileSync(join(root, 'static/chat/ui.js'), 'utf8');
const activity = readFileSync(join(root, 'static/chat/activity-ui.js'), 'utf8');
const realtime = readFileSync(join(root, 'static/chat/realtime-render.js'), 'utf8');
const marked = readFileSync(join(root, 'static/marked.min.js'), 'utf8');

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing section: ${start}`);
  return source.slice(from, to);
}

function element(tagName) {
  return {
    tagName,
    innerHTML: '',
    textContent: '',
    dataset: {},
    children: [],
    classList: { add() {} },
    append(...children) { this.children.push(...children); },
  };
}

const sandbox = {
  document: { createElement: element },
  t: (key) => key,
  activityText: (key) => key,
  summarizeToolInput: () => '',
  formatDecodedDisplayText: (source) => source.replace(/<private>[\s\S]*?<\/private>/gi, ''),
  renderMathInMarkdownSource: (source) => source,
  enhanceCodeBlocks() {},
  enhanceRenderedContentLinks() {},
  createActivityDisclosure() {
    const card = element('details');
    const body = element('div');
    card.append(body);
    return { card, body };
  },
  markLazyEventBodyNode(node, evt, { renderMode } = {}) {
    if (evt?.bodyAvailable && !evt.bodyLoaded) node.dataset.bodyRender = renderMode;
  },
};
sandbox.globalThis = sandbox;
vm.runInNewContext(marked, sandbox);
vm.runInNewContext([
  section(ui, 'function renderMarkdownIntoNode(', '\nfunction markLazyEventBodyNode('),
  activity.slice(activity.indexOf('function renderActivityNote(')),
  section(ui, 'function renderManagerContextInto(', '\nfunction collectHiddenBlockToolNames('),
  section(realtime, 'function applyLazyBodyToNode(', '\nfunction cleanBase64TextForDisplay('),
  'globalThis.view = renderManagerContextInto; globalThis.loadFull = applyLazyBodyToNode;',
].join('\n'), sandbox);

const exact = `# Startup\n\n<private>\n## Internal detail\nKeep this visible.\n</private>\n\n<hide>Also visible.</hide>\n\n${'x'.repeat(4200)} TAIL`;
const container = element('div');
sandbox.view(container, { contextKind: 'model', content: exact });
const body = container.children[0].children[0];
const content = body.children[0];
assert.equal(content.tagName, 'div', 'model context should retain the Markdown activity view');
assert.equal(body.children.length, 1, 'model context should not add a copy control');
assert.match(content.innerHTML, /<h1>Startup<\/h1>/);
assert.match(content.innerHTML, /<h2>Internal detail<\/h2>/);
assert.match(content.innerHTML, /&lt;private&gt;/);
assert.match(content.innerHTML, /&lt;hide&gt;Also visible\.&lt;\/hide&gt;/);
assert.match(content.innerHTML, /x{4200} TAIL/, 'long context should not be clipped');

const deferredContainer = element('div');
sandbox.view(deferredContainer, {
  contextKind: 'model',
  bodyAvailable: true,
  bodyLoaded: false,
  seq: 7,
  bodyPreview: '# partial preview',
});
const deferred = deferredContainer.children[0].children[0].children[0];
assert.equal(deferred.dataset.bodyRender, 'markdown-full');
sandbox.loadFull(deferred, { value: exact });
assert.match(deferred.innerHTML, /Keep this visible\./);
assert.match(deferred.innerHTML, /x{4200} TAIL/, 'loaded full body should replace the preview');

console.log('test-chat-model-context-markdown-view: ok');
