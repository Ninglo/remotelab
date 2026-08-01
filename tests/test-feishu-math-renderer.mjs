import assert from 'assert/strict';

import {
  buildFeishuMathDocument,
  createFeishuFormulaImageResolver,
  renderLatexToPng,
} from '../connectors/feishu/math-renderer.mjs';

const simpleDocument = await buildFeishuMathDocument(
  '分布满足 $q_t(Z\\mid query)\\propto p(Z)^{1/2}$。',
);
assert.equal(simpleDocument.blocks.length, 1);
assert.equal(simpleDocument.blocks[0].type, 'line');
assert.equal(simpleDocument.blocks[0].segments.length, 3);
assert.equal(simpleDocument.blocks[0].segments[1].type, 'inline_math');
assert.match(simpleDocument.blocks[0].segments[1].text, /qₜ/);
assert.match(simpleDocument.blocks[0].segments[1].text, /∣/);
assert.match(simpleDocument.blocks[0].segments[1].text, /∝/);
assert.doesNotMatch(simpleDocument.blocks[0].segments[1].text, /\\[a-zA-Z]+/);

const displaySource = String.raw`\begin{aligned}
\max_Z\quad &q_t(Z\mid query)\\
&\propto p(Z)\cdot \text{未来问题}
\end{aligned}`;
const displayRequests = [];
const displayDocument = await buildFeishuMathDocument(
  `推导如下：\n\\[\n${displaySource}\n\\]\n完成。`,
  {
    resolveFormulaImage: async (formula) => {
      displayRequests.push(formula);
      return 'img_formula_1';
    },
  },
);
assert.equal(displayRequests.length, 1);
assert.equal(displayRequests[0].source, displaySource);
assert.equal(displayRequests[0].display, true);
assert.deepEqual(displayDocument.blocks[1], {
  type: 'formula_image',
  source: displaySource,
  imageKey: 'img_formula_1',
});

const standaloneEnvironmentDocument = await buildFeishuMathDocument(
  displaySource,
  {
    resolveFormulaImage: async () => 'img_formula_environment_1',
  },
);
assert.deepEqual(standaloneEnvironmentDocument.blocks, [{
  type: 'formula_image',
  source: displaySource,
  imageKey: 'img_formula_environment_1',
}]);

const formulaErrors = [];
const failedDocument = await buildFeishuMathDocument(
  `$$${displaySource}$$`,
  {
    resolveFormulaImage: async () => {
      throw new Error('synthetic render failure');
    },
    onFormulaError: (error, formula) => {
      formulaErrors.push({ error, formula });
    },
  },
);
assert.equal(failedDocument.blocks[0].type, 'formula_fallback');
assert.equal(failedDocument.blocks[0].source, displaySource);
assert.match(failedDocument.blocks[0].text, /\\begin\{aligned\}/);
assert.match(failedDocument.blocks[0].text, /\\text\{未来问题\}/);
assert.equal(formulaErrors.length, 1);
assert.match(formulaErrors[0].error.message, /synthetic render failure/);
assert.equal(formulaErrors[0].formula.display, true);

const fencedDocument = await buildFeishuMathDocument(
  '```latex\n$x^2$\n```\n正文 $x^2$',
);
assert.equal(fencedDocument.blocks[1].type, 'line');
assert.equal(
  fencedDocument.blocks[1].segments.some((segment) => segment.type === 'inline_math'),
  false,
  'math delimiters inside fenced code must remain literal',
);
assert.equal(
  fencedDocument.blocks[3].segments.some((segment) => segment.type === 'inline_math'),
  true,
);

let renderCalls = 0;
let uploadCalls = 0;
const resolver = createFeishuFormulaImageResolver({
  renderFormula: async () => {
    renderCalls += 1;
    return Buffer.from('png');
  },
  uploadImage: async (buffer) => {
    uploadCalls += 1;
    assert.equal(buffer.toString(), 'png');
    return 'img_cached_1';
  },
});
assert.equal(await resolver({ source: displaySource, display: true }), 'img_cached_1');
assert.equal(await resolver({ source: displaySource, display: true }), 'img_cached_1');
assert.equal(renderCalls, 1, 'same formula should render once');
assert.equal(uploadCalls, 1, 'same formula should upload once');

await assert.rejects(
  () => renderLatexToPng(String.raw`\href{javascript:alert(1)}{x}`, { display: true }),
  /unsafe|unsupported/i,
);

const png = await renderLatexToPng(displaySource, { display: true });
assert.ok(Buffer.isBuffer(png));
assert.deepEqual(
  Array.from(png.subarray(0, 8)),
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
);
assert.ok(png.length > 1000, 'rendered formula PNG should contain real image data');

console.log('ok - Feishu formulas use standard parsing, image rendering, cache reuse, and safe fallback');
