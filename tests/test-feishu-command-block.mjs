import assert from 'node:assert/strict';
import {
  feishuCommandAliases,
  parseFeishuCommandBlock,
  resolveFeishuCommandName,
} from '../connectors/feishu/command-parser.mjs';

assert.deepEqual(feishuCommandAliases, { m: 'model', q: 'quick' });
for (const text of ['/log Auto Research 数据接入', '@Index /log Auto Research 数据接入']) {
  assert.deepEqual(parseFeishuCommandBlock(text), { commands: [{ name: 'log', value: 'Auto Research 数据接入' }], body: '' });
}
assert.deepEqual(parseFeishuCommandBlock('/log\n帮我找历史对话\n/model beta'), {
  commands: [{ name: 'log', value: '帮我找历史对话\n/model beta' }], body: '',
}, 'everything following /log is a literal query, not another command');
assert.deepEqual(parseFeishuCommandBlock('/log'), { commands: [{ name: 'log', value: '' }], body: '' });
assert.match(parseFeishuCommandBlock('/model alpha\n/log topic').error, /单独使用/);
for (const [alias, canonicalName] of Object.entries(feishuCommandAliases)) {
  assert.equal(resolveFeishuCommandName(alias), canonicalName);
  assert.equal(resolveFeishuCommandName(canonicalName), canonicalName);
}

assert.deepEqual(parseFeishuCommandBlock('/thread\n/model gpt-5.6\n/effort high\n\n请继续分析。'), {
  commands: [
    { name: 'thread' },
    { name: 'model', value: 'gpt-5.6' },
    { name: 'effort', value: 'high' },
  ],
  body: '请继续分析。',
});
assert.deepEqual(parseFeishuCommandBlock('@Task Bot /thread\n\n任务正文'), {
  commands: [{ name: 'thread' }], body: '任务正文',
});
assert.deepEqual(parseFeishuCommandBlock('/thread 帮我调查这个问题'), {
  commands: [{ name: 'thread' }], body: '帮我调查这个问题',
});
assert.deepEqual(parseFeishuCommandBlock('/inline 继续处理这个问题'), {
  commands: [{ name: 'inline' }], body: '继续处理这个问题',
});
assert.deepEqual(parseFeishuCommandBlock('/m gpt-5.6'), {
  commands: [{ name: 'model', value: 'gpt-5.6' }], body: '',
});
assert.deepEqual(parseFeishuCommandBlock('/q 一句话解释这个概念'), {
  commands: [{ name: 'quick' }], body: '一句话解释这个概念',
});
assert.deepEqual(parseFeishuCommandBlock('@Task Bot /thread --harness codex --model=gpt-5.6 --effort high 请分析这个问题'), {
  commands: [
    { name: 'thread' },
    { name: 'harness', value: 'codex' },
    { name: 'model', value: 'gpt-5.6' },
    { name: 'effort', value: 'high' },
  ],
  body: '请分析这个问题',
});
assert.deepEqual(parseFeishuCommandBlock('/inline\n直接沿用上文继续处理\n保留原始格式'), {
  commands: [{ name: 'inline' }], body: '直接沿用上文继续处理\n保留原始格式',
});
assert.deepEqual(parseFeishuCommandBlock('/thread --model gpt-5.6\n/effort high\n正文不再需要空行'), {
  commands: [
    { name: 'thread' },
    { name: 'model', value: 'gpt-5.6' },
    { name: 'effort', value: 'high' },
  ],
  body: '正文不再需要空行',
});
assert.deepEqual(parseFeishuCommandBlock('/thread -- --保留这个正文开头'), {
  commands: [{ name: 'thread' }], body: '--保留这个正文开头',
});
assert.deepEqual(parseFeishuCommandBlock('/quick\n\n一句话解释这个概念'), {
  commands: [{ name: 'quick' }], body: '一句话解释这个概念',
});
for (const text of ['/sota 深入分析这个问题', '/sota\n深入分析这个问题', '@Task Bot /SOTA\n\n深入分析这个问题']) {
  assert.deepEqual(parseFeishuCommandBlock(text), {
    commands: [{ name: 'sota' }], body: '深入分析这个问题',
  });
}
assert.deepEqual(parseFeishuCommandBlock('/sota'), { commands: [{ name: 'sota' }], body: '' });
assert.deepEqual(parseFeishuCommandBlock('普通正文里提到 /thread 和 /model x'), {
  commands: [], body: '普通正文里提到 /thread 和 /model x',
});

for (const body of [
  '@Task Bot /mnt/train/public 的旧数据对象已全部删除',
  '/root/workspace/MUKA-FoundationModel 已经 git clone 了 git 仓库，看看能不能访问',
  '/f/data 是一个普通路径',
  '/m/checkpoints/model.bin',
  '/q/archive/result.json',
  '/sota/results.json',
  '/fork old command is ordinary text',
  '/continue old command is ordinary text',
  '/unknown',
  '/constructor',
]) {
  assert.deepEqual(parseFeishuCommandBlock(body), { commands: [], body },
    'text that does not resolve to a registered command must remain ordinary task text');
}

assert.deepEqual(parseFeishuCommandBlock('/thread\n任务正文'), {
  commands: [{ name: 'thread' }], body: '任务正文',
});
assert.equal(parseFeishuCommandBlock('/thread\n/unknown\n\n任务正文').error, '未知命令：/unknown（第 2 行）');
assert.equal(parseFeishuCommandBlock('/thread --unknown value 任务正文').error, '未知修饰参数：--unknown（第 1 行）');
assert.equal(parseFeishuCommandBlock('/thread --model').error, '--model 需要一个不含空格的值（第 1 行）');
assert.equal(parseFeishuCommandBlock('/model a b').error, '/model 需要一个不含空格的参数（第 1 行）');
assert.match(
  parseFeishuCommandBlock('/default model gpt-5.6').error,
  /固定为 Auto/,
  'the removed mutable Default command should explain the immutable Auto rule',
);
assert.match(parseFeishuCommandBlock('/follow').error, /固定为 Auto/);

console.log('test-feishu-command-block: ok');
