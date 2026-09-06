import assert from 'assert/strict';
import { buildFeishuPostContent } from '../connectors/feishu/index.mjs';

const rows = async (text, mentions, options) => JSON.parse(
  await buildFeishuPostContent(text, mentions, options),
).zh_cn.content;
const table = [
  '| 检查项 | 结果 |',
  '|---|---|',
  '| Wiki、Doc | 读取正常 |',
  '| 画板 | 已恢复，成功读取 361 个节点 |',
  '| 电子表格 | 已恢复，成功读取 2 个工作表 |',
  '| 任务详情 | 5 个任务均仍被拒绝 |',
].join('\n');
const report = `巡检结果：\n\n${table}\n\n仍需补齐任务访问授权。`;
assert.deepEqual(await rows(report), [[{ tag: 'md', text: report }]],
  'a GFM table header, delimiter, and body must stay in one Markdown element');

const lists = '3. 第三项\n4. 第四项\n\n- [ ] 待处理\n  - 子项\n- [x] 已完成\n\n> 第一行\n> 第二行';
assert.deepEqual(await rows(lists), [[{ tag: 'md', text: lists }]],
  'multiline lists and quotes must retain their context and indentation');

const mentions = [{ key: '@_user_1', openId: 'ou_test', name: '负责人' }];
const mentionTable = '| 事项 | 负责人 |\n|---|---|\n| **跟进** | @_user_1 |';
const mentionTag = '<at user_id="ou_test">负责人</at>';
assert.deepEqual(await rows(mentionTable, mentions), [[{
  tag: 'md', text: mentionTable.replace('@_user_1', mentionTag),
}]], 'mentions inside a table must not split its Markdown element');
assert.deepEqual(await rows('@负责人 请看 `@负责人` 和 ``@_user_1``。', mentions), [[{
  tag: 'md', text: `${mentionTag} 请看 \`@负责人\` 和 \`\`@_user_1\`\`。`,
}]], 'code spans must remain literal when converting native mentions');

assert.deepEqual(await rows(`前文\n\n${table}\n\n\`\`\`ts\n  const who = "@_user_1";\n\`\`\`\n\n后文`, mentions), [
  [{ tag: 'md', text: `前文\n\n${table}` }],
  [{ tag: 'code_block', language: 'TYPESCRIPT', text: '  const who = "@_user_1";' }],
  [{ tag: 'md', text: '后文' }],
], 'native code blocks remain separate without splitting adjacent tables');

assert.deepEqual(await rows(`${table}\n\n$$x^2$$\n\n完成。`, [], {
  resolveFormulaImage: async () => 'img_formula_test',
}), [
  [{ tag: 'md', text: table }],
  [{ tag: 'img', image_key: 'img_formula_test' }],
  [{ tag: 'md', text: '完成。' }],
], 'display formula images keep their own paragraph between Markdown blocks');

console.log('ok - Feishu preserves GFM blocks, native mentions, code, and formula boundaries');
