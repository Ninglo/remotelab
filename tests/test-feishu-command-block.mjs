import assert from 'node:assert/strict';
import { parseFeishuCommandBlock } from '../connectors/feishu/command-parser.mjs';

assert.deepEqual(parseFeishuCommandBlock('/fork\n/model gpt-5.6\n/effort high\n\n请继续分析。'), {
  commands: [
    { name: 'fork' },
    { name: 'model', value: 'gpt-5.6' },
    { name: 'effort', value: 'high' },
  ],
  body: '请继续分析。',
});

assert.deepEqual(parseFeishuCommandBlock('@Task Bot /fork\n\n任务正文'), {
  commands: [{ name: 'fork' }],
  body: '任务正文',
});

assert.deepEqual(parseFeishuCommandBlock('普通正文里提到 /fork 和 /model x'), {
  commands: [],
  body: '普通正文里提到 /fork 和 /model x',
});

assert.equal(parseFeishuCommandBlock('/fork\n任务正文').error, '命令必须连续写在消息开头；命令和任务正文之间要空一行。');
assert.equal(parseFeishuCommandBlock('/unknown').error, '未知命令：/unknown（第 1 行）');
assert.equal(parseFeishuCommandBlock('/model a b').error, '/model 需要一个不含空格的参数（第 1 行）');
assert.deepEqual(parseFeishuCommandBlock('/default model gpt-5.6'), {
  commands: [{ name: 'default', field: 'model', value: 'gpt-5.6' }],
  body: '',
});

console.log('test-feishu-command-block: ok');
