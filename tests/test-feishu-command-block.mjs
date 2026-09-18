import assert from 'node:assert/strict';
import {
  feishuCommandAliases,
  parseFeishuCommandBlock,
  resolveFeishuCommandName,
} from '../connectors/feishu/command-parser.mjs';

assert.deepEqual(feishuCommandAliases, {
  m: 'model',
  f: 'fork',
  q: 'quick',
  c: 'continue',
});
for (const [alias, canonicalName] of Object.entries(feishuCommandAliases)) {
  assert.equal(resolveFeishuCommandName(alias), canonicalName);
  assert.equal(resolveFeishuCommandName(canonicalName), canonicalName);
}

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

assert.deepEqual(parseFeishuCommandBlock('/fork 帮我调查这个问题'), {
  commands: [{ name: 'fork' }],
  body: '帮我调查这个问题',
});

assert.deepEqual(parseFeishuCommandBlock('/f --model gpt-5.6 帮我调查这个问题'), {
  commands: [
    { name: 'fork' },
    { name: 'model', value: 'gpt-5.6' },
  ],
  body: '帮我调查这个问题',
});

assert.deepEqual(parseFeishuCommandBlock('/m gpt-5.6'), {
  commands: [{ name: 'model', value: 'gpt-5.6' }],
  body: '',
});

assert.deepEqual(parseFeishuCommandBlock('/q 一句话解释这个概念'), {
  commands: [{ name: 'quick' }],
  body: '一句话解释这个概念',
});

assert.deepEqual(parseFeishuCommandBlock('/c 继续处理这个问题'), {
  commands: [{ name: 'continue' }],
  body: '继续处理这个问题',
});

assert.deepEqual(parseFeishuCommandBlock('@Task Bot /fork --harness codex --model=gpt-5.6 --effort high 请分析这个问题'), {
  commands: [
    { name: 'fork' },
    { name: 'harness', value: 'codex' },
    { name: 'model', value: 'gpt-5.6' },
    { name: 'effort', value: 'high' },
  ],
  body: '请分析这个问题',
});

assert.deepEqual(parseFeishuCommandBlock('/continue\n直接沿用上文继续处理\n保留原始格式'), {
  commands: [{ name: 'continue' }],
  body: '直接沿用上文继续处理\n保留原始格式',
});

assert.deepEqual(parseFeishuCommandBlock('/fork --model gpt-5.6\n/effort high\n正文不再需要空行'), {
  commands: [
    { name: 'fork' },
    { name: 'model', value: 'gpt-5.6' },
    { name: 'effort', value: 'high' },
  ],
  body: '正文不再需要空行',
});

assert.deepEqual(parseFeishuCommandBlock('/fork -- --保留这个正文开头'), {
  commands: [{ name: 'fork' }],
  body: '--保留这个正文开头',
});

assert.deepEqual(parseFeishuCommandBlock('/quick\n\n一句话解释这个概念'), {
  commands: [{ name: 'quick' }],
  body: '一句话解释这个概念',
});

assert.deepEqual(parseFeishuCommandBlock('普通正文里提到 /fork 和 /model x'), {
  commands: [],
  body: '普通正文里提到 /fork 和 /model x',
});

for (const body of [
  '@Task Bot /mnt/train/public 的旧数据对象已全部删除',
  '/root/workspace/MUKA-FoundationModel 已经 git clone 了 git 仓库，看看能不能访问',
  '/f/data 是一个普通路径',
  '/m/checkpoints/model.bin',
  '/q/archive/result.json',
  '/e high',
  '/ha codex',
  '/s',
  '/d model gpt-5.6',
  '/fo',
  '/mu',
  '/u',
  '/h',
  '/unknown',
  '/constructor',
]) {
  assert.deepEqual(parseFeishuCommandBlock(body), {
    commands: [],
    body,
  }, 'text that does not resolve to a registered command must remain ordinary task text');
}

assert.deepEqual(parseFeishuCommandBlock('/fork\n任务正文'), {
  commands: [{ name: 'fork' }],
  body: '任务正文',
});
assert.equal(parseFeishuCommandBlock('/fork\n/unknown\n\n任务正文').error, '未知命令：/unknown（第 2 行）');
assert.equal(parseFeishuCommandBlock('/fork --unknown value 任务正文').error, '未知修饰参数：--unknown（第 1 行）');
assert.equal(parseFeishuCommandBlock('/fork --model').error, '--model 需要一个不含空格的值（第 1 行）');
assert.equal(parseFeishuCommandBlock('/model a b').error, '/model 需要一个不含空格的参数（第 1 行）');
assert.deepEqual(parseFeishuCommandBlock('/default model gpt-5.6'), {
  commands: [{ name: 'default', field: 'model', value: 'gpt-5.6' }],
  body: '',
});

console.log('test-feishu-command-block: ok');
