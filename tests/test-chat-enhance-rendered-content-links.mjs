#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const sessionHttpHelpersSource = readFileSync(join(repoRoot, 'static', 'chat', 'session-http-helpers.js'), 'utf8');

function extractSnippet(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} should exist`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `${endMarker} should exist after ${startMarker}`);
  return source.slice(start, end);
}

function extractFunctionSource(source, functionName) {
  const marker = `function ${functionName}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${functionName} should exist`);
  const paramsStart = source.indexOf('(', start);
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

function createLink(href) {
  return {
    href,
    target: '',
    rel: '',
    attributes: new Map([['href', href]]),
    getAttribute(name) {
      return this.attributes.get(name) || '';
    },
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
      if (name === 'href') this.href = String(value);
    },
  };
}

const productHrefSnippet = extractSnippet(
  sessionHttpHelpersSource,
  'const PRODUCT_LOCAL_HREF_RE',
  'function enhanceRenderedContentLinks',
);
const enhanceRenderedContentLinksSource = extractFunctionSource(sessionHttpHelpersSource, 'enhanceRenderedContentLinks');

const apiLink = createLink('/api/assets/fasset_demo/download');
const externalLink = createLink('https://example.com/docs');
const context = {
  console,
  window: {
    remotelabResolveProductPath(path) {
      return `/trial6${path}`;
    },
  },
};
context.globalThis = context;

vm.runInNewContext(
  [
    productHrefSnippet,
    enhanceRenderedContentLinksSource,
    'globalThis.enhanceRenderedContentLinks = enhanceRenderedContentLinks;',
  ].join('\n\n'),
  context,
  { filename: 'static/chat/session-http-helpers.js' },
);

context.enhanceRenderedContentLinks({
  querySelectorAll(selector) {
    assert.equal(selector, 'a[href]', 'link enhancer should only inspect anchor hrefs');
    return [apiLink, externalLink];
  },
});

assert.equal(
  apiLink.href,
  '/trial6/api/assets/fasset_demo/download',
  'product-local links in rendered markdown should inherit the current product prefix',
);
assert.equal(apiLink.target, '', 'product-local links should stay same-tab');
assert.equal(apiLink.rel, '', 'product-local links should not force external rel flags');

assert.equal(externalLink.href, 'https://example.com/docs', 'external links should keep their original href');
assert.equal(externalLink.target, '_blank', 'external links should still open in a new tab');
assert.equal(externalLink.rel, 'noopener noreferrer', 'external links should keep safe rel flags');

console.log('test-chat-enhance-rendered-content-links: ok');
