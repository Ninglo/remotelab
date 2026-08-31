#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const uiSource = readFileSync(join(repoRoot, 'static', 'chat', 'ui.js'), 'utf8');

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
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unable to extract ${functionName}`);
}

const context = { console };
context.globalThis = context;

const mathBlockStart = uiSource.indexOf('function escapeMathHtml');
const mathBlockEnd = uiSource.indexOf('function renderMarkdownIntoNode');
assert.notEqual(mathBlockStart, -1, 'math helper block should start at escapeMathHtml');
assert.notEqual(mathBlockEnd, -1, 'math helper block should end before renderMarkdownIntoNode');

vm.runInNewContext(
  [
    uiSource.slice(mathBlockStart, mathBlockEnd),
    'globalThis.renderMathInMarkdownSource = renderMathInMarkdownSource;',
  ].join('\n\n'),
  context,
  { filename: 'static/chat/ui.js' },
);

const rendered = context.renderMathInMarkdownSource('Inline $x_i = y^2$ and block:\n$$\n\\frac{a_b}{c^2}\n$$');

assert.match(rendered, /<math\b[^>]*data-math="inline"/, 'inline math should render as MathML');
assert.match(rendered, /<msub><mi>x<\/mi><mi>i<\/mi><\/msub>/, 'inline subscript should render structurally');
assert.match(rendered, /<msup><mi>y<\/mi><mn>2<\/mn><\/msup>/, 'inline superscript should render structurally');
assert.match(rendered, /<math\b[^>]*display="block"[^>]*data-math="display"/, 'display math should render as display MathML');
assert.match(rendered, /<mfrac>/, 'display fractions should render structurally');
assert.doesNotMatch(rendered, /class="math-inline"[^>]*>x_i = y\^2/, 'math should not be emitted as raw grey-box source');

const protectedCode = context.renderMathInMarkdownSource('Keep `$x_i$` and:\n```js\nconst price = "$5";\n```');
assert.match(protectedCode, /`\$x_i\$`/, 'inline code math-looking text should be protected');
assert.match(protectedCode, /const price = "\$5";/, 'code fences should be protected');

console.log('test-chat-math-rendering: ok');
