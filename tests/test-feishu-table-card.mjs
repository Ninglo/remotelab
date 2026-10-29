import assert from 'node:assert/strict';
import { buildFeishuPostContent } from '../connectors/feishu/index.mjs';
import { buildFeishuTableCard } from '../connectors/feishu/table-card.mjs';

const table = '| **日期** | 当天主要在忙什么 |\n|:---|---:|\n| 10/5 | **梳理方向**。讨论工作指标、后续实践和试用安排。 |';
const convert = async (text, mentions, options) => {
  const card = await buildFeishuTableCard(await buildFeishuPostContent(text, mentions, options));
  return card && JSON.parse(card);
};
const card = await convert(`开头说明。\n\n${table}\n\n结束说明。`);
assert.equal(card.schema, '2.0');
assert.deepEqual(card.body.elements.map(item => item.tag), ['markdown', 'table', 'markdown']);
const native = card.body.elements[1];
assert.equal(native.columns[0].display_name, '日期');
assert.ok(parseInt(native.columns[1].width) > parseInt(native.columns[0].width));
assert.equal(native.columns[1].horizontal_align, 'right');
assert.equal(native.rows[0].column_1, '**梳理方向**。讨论工作指标、后续实践和试用安排。');

for (const text of ['a | b', `\`\`\`md\n${table}\n\`\`\``, table.split('\n').map(line => `    ${line}`).join('\n')]) {
  assert.equal(await convert(text), null, 'literal pipes and code must not become tables');
}
const rich = await convert('| 姓名 | 内容 |\n|---|---|\n| @_user_1 | `a\\|b` [链接](https://example.com) |',
  [{ key: '@_user_1', openId: 'ou_test', name: '负责人' }]);
assert.equal(rich.body.elements[0].rows[0].column_0, '<at id="ou_test">负责人</at>');
assert.equal(rich.body.elements[0].rows[0].column_1, '`a|b` [链接](https://example.com)');

const mixed = await convert(`${table}\n\n\`\`\`js\nconst literal = '<at user_id="ou_test">name</at>';\n\`\`\`\n\n$$\\frac{a}{b}$$\n\n结束。`, [], {
  resolveFormulaImage: async () => 'img_formula',
});
assert.deepEqual(mixed.body.elements.map(item => item.tag), ['table', 'markdown', 'img', 'markdown']);
assert.match(mixed.body.elements[1].content, /<at user_id=/, 'code is literal');
assert.equal(mixed.body.elements[2].img_key, 'img_formula');

const manyRows = '| id | value |\n|---|---|\n' + Array.from({ length: 25 }, (_, i) => `| ${i} | value ${i} |`).join('\n');
const paged = (await convert(manyRows)).body.elements[0];
assert.equal(paged.rows.length, 25, 'all rows survive pagination');
assert.equal(paged.page_size, 10);
assert.equal((await convert(Array(5).fill(table).join('\n\n'))).body.elements.length, 5);
assert.equal(await convert(Array(6).fill(table).join('\n\n')), null);
assert.equal(await buildFeishuTableCard(JSON.stringify({ zh_cn: { content: [[{ tag: 'md',
  text: `| a | b |\n|---|---|\n| a | ${'内容'.repeat(6000)} |`,
}]] } })), null, 'oversize cards fall back without truncation');
assert.equal(await convert(`${table}\n\n[x]: https://example.com`), null, 'reference definitions retain post scope');
assert.equal(await convert(`| ${Array(51).fill('col').join(' | ')} |\n| ${Array(51).fill('---').join(' | ')} |\n| ${Array(51).fill('value').join(' | ')} |`), null);
console.log('ok - Feishu native table cards preserve content, code, mentions, formulas and pagination');
