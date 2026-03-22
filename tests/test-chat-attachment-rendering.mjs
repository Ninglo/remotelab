#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const uiSource = readFileSync(join(repoRoot, 'static', 'chat', 'ui.js'), 'utf8');
const chatTemplateSource = readFileSync(join(repoRoot, 'templates', 'chat.html'), 'utf8');

function extractFunctionSource(source, functionName) {
  const marker = `function ${functionName}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${functionName} should exist in ui.js`);
  const paramsStart = source.indexOf('(', start);
  assert.notEqual(paramsStart, -1, `${functionName} should have parameters`);
  let paramsDepth = 0;
  let braceStart = -1;
  for (let index = paramsStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') paramsDepth += 1;
    if (char === ')') {
      paramsDepth -= 1;
      if (paramsDepth === 0) {
        braceStart = source.indexOf('{', index);
        break;
      }
    }
  }
  assert.notEqual(braceStart, -1, `${functionName} should have a body`);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  throw new Error(`Unable to extract ${functionName}`);
}

function createElement(tagName = 'div') {
  return {
    tagName: String(tagName || 'div').toUpperCase(),
    className: '',
    textContent: '',
    innerHTML: '',
    title: '',
    href: '',
    target: '',
    rel: '',
    src: '',
    alt: '',
    loading: '',
    controls: false,
    preload: '',
    muted: false,
    playsInline: false,
    dataset: {},
    children: [],
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    setAttribute(name, value) {
      this[name] = value;
    },
    getAttribute(name) {
      return this[name] || null;
    },
  };
}

const context = {
  console,
  document: {
    createElement,
  },
  renderUiIcon(name) {
    return `<svg data-icon="${name}"></svg>`;
  },
  window: {
    open() {},
  },
};
context.globalThis = context;

const functionsToLoad = [
  'getAttachmentDisplayName',
  'getAttachmentKind',
  'getAttachmentSource',
  'getAttachmentTypeLabel',
  'createAttachmentFileNode',
  'createMessageAttachmentNode',
  'createComposerAttachmentPreviewNode',
];

vm.runInNewContext(
  [
    ...functionsToLoad.map((name) => extractFunctionSource(uiSource, name)),
    'globalThis.createMessageAttachmentNode = createMessageAttachmentNode;',
    'globalThis.createComposerAttachmentPreviewNode = createComposerAttachmentPreviewNode;',
  ].join('\n\n'),
  context,
  { filename: 'static/chat/ui.js' },
);

assert.match(
  chatTemplateSource,
  /id="imgFileInput"[^>]*accept="\*\/\*"/,
  'chat attachment picker should accept all file types',
);
assert.doesNotMatch(
  chatTemplateSource,
  /id="imgFileInput"[^>]*accept="image\/\*,video\/\*"/,
  'chat attachment picker should no longer be limited to images and videos',
);

const genericMessageNode = context.createMessageAttachmentNode({
  filename: 'stored-report.csv',
  originalName: 'report.csv',
  mimeType: 'text/csv',
});
assert.equal(genericMessageNode.tagName, 'A', 'generic message attachments should render as links');
assert.ok(genericMessageNode.className.includes('attachment-card'), 'generic message attachments should render as file cards');
assert.equal(genericMessageNode.href, '/api/media/stored-report.csv', 'generic message attachment should point at the media route');
assert.equal(genericMessageNode.children.length, 1, 'generic file card should include an inner preview node');
assert.equal(genericMessageNode.children[0].className, 'attachment-file', 'generic file card should reuse the attachment file shell');
assert.equal(genericMessageNode.children[0].children[1].children[0].textContent, 'report.csv', 'generic file card should show the original file name');
assert.equal(genericMessageNode.children[0].children[1].children[1].textContent, 'CSV', 'generic file card should show a file type label');

const genericComposerPreview = context.createComposerAttachmentPreviewNode({
  objectUrl: 'blob:report',
  originalName: 'report.csv',
  mimeType: 'text/csv',
});
assert.equal(genericComposerPreview.tagName, 'DIV', 'generic composer attachments should render as preview cards');
assert.ok(genericComposerPreview.className.includes('attachment-file-compact'), 'generic composer attachments should use the compact file preview card');

const imageComposerPreview = context.createComposerAttachmentPreviewNode({
  objectUrl: 'blob:image',
  originalName: 'shot.png',
  mimeType: 'image/png',
});
assert.equal(imageComposerPreview.tagName, 'IMG', 'image composer attachments should still render as image previews');

const audioMessageNode = context.createMessageAttachmentNode({
  filename: 'voice.wav',
  originalName: 'voice.wav',
  mimeType: 'audio/wav',
});
assert.equal(audioMessageNode.tagName, 'AUDIO', 'audio message attachments should keep native audio controls');

console.log('test-chat-attachment-rendering: ok');
