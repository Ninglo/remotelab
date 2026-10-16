// Opt-in semantic smoke. Real installed model, synthetic conversations, no Feishu.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveFeishuGroupSettings } from '../connectors/feishu/group-settings.mjs';
import { resolveAmbientFeishuReplyPlan } from '../chat/ambient-feishu-reply.mjs';
import { readFeishuResponseDecision } from '../lib/feishu-response-decision.mjs';
import { FEISHU_CONFIRMED_REACTION_CANDIDATES } from '../lib/feishu-reaction-catalog.mjs';

if (process.env.REMOTELAB_LIVE_FEISHU_RESPONSE !== '1') {
  console.log('SKIP: set REMOTELAB_LIVE_FEISHU_RESPONSE=1 to spend real model budget.');
  process.exit(0);
}
const out = await mkdtemp(join(tmpdir(), 'feishu-response-live-'));
const config = { defaultGroupParticipation: 'active', groupReactionCandidates: FEISHU_CONFIRMED_REACTION_CANDIDATES };
const cases = [
  { id: 'topic-followup', topic: true, thread: true, mode: 'thread',
    input: '已有话题：人请你帮忙拟会议通知，原定明天10点。已回复通知草稿。当前输入 id=t1：「改成11点，其他不变」。',
    check: d => assert.match(d.text, /11|十一/) },
  { id: 'active-jev-failure', mode: 'inline',
    input: '普通群主动参与，Jev反馈失败。当前输入 id=a1：「Agent，17加25等于多少？」',
    check: d => assert.match(d.text, /42|四十二/) },
  { id: 'human-chatter', mode: 'inline', silent: true,
    input: '普通群主动参与。当前输入 id=h1：小王对小李说「我到楼下了，你下来吧」。你没有相关工作、问题或额外信息。',
    check: d => { assert.ok(d.noTextReason); assert.equal(d.text, ''); } },
  { id: 'combine-correction', mode: 'inline', ids: ['b1', 'b2', 'b3'],
    input: '普通群主动参与，以下均已收到且未回答。id=b1：「Agent，帮我算3箱每箱8瓶一共多少瓶」。id=b2：「另外，7乘9是多少？一起回就好」。id=b3：「纠正一下，每箱是10瓶，不是8瓶」。',
    check: d => { assert.match(d.text, /30|三十/); assert.match(d.text, /63|六十三/); assert.doesNotMatch(d.text, /一共24|共计24/); } },
  { id: 'complex-thread', mode: 'thread',
    input: '普通群主线，当前输入 id=c1：「Agent，帮我比较一个长期会议资料整理方案：人工归档、自动转写后归档、完全自动分类。请讨论维护成本和如何逐步试用，接下来我们会继续调整。现在只讨论，不执行、不转交、不新建工作Session。」',
    check: d => { assert.match(d.text, /人工/); assert.match(d.text, /自动/); assert.ok(d.text.length > 80); } },
  { id: 'existing-thread-short', mode: 'thread', thread: true,
    input: '普通群已有工作话题。上文你正在讨论预算。当前输入 id=e1：「顺便问一句，8乘9是多少？」',
    check: d => assert.match(d.text, /72|七十二/) },
];
const results = [];
for (const test of cases) {
  const summary = { chatId: 'synthetic', chatType: 'group', chatMode: test.topic ? 'topic' : 'group',
    ...(test.thread ? { threadId: 'synthetic-thread', rootId: 'synthetic-root' } : {}) };
  const rules = resolveFeishuGroupSettings(config, summary).systemPrompt;
  const prompt = `这是一次隔离的回复行为测试。下面是实际回复规则和模拟对话；请直接给出你作为其中Agent的最终回复（包含规则要求的隐藏决定）。不要解释测试、调用工具或访问任何服务。\n\n${rules}\n\n${test.input}`;
  const path = join(out, `${test.id}.txt`);
  const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only',
    '-c', 'project_doc_max_bytes=0', '-o', path, '-'];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('REMOTELAB_')));
  const result = await new Promise(resolve => {
    const child = spawn(process.env.REMOTELAB_SMOKE_CODEX || 'codex', args, { cwd: out, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => child.kill('SIGTERM'), 120000);
    child.on('error', error => { clearTimeout(timer); resolve({ code: -1, error: error.message }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(prompt);
  });
  await writeFile(join(out, `${test.id}.json`), JSON.stringify({ input: test.input, rules, ...result }, null, 2));
  let decision, error;
  try {
    assert.equal(result.code, 0, result.error || result.stderr?.slice(-1000));
    decision = readFeishuResponseDecision(await readFile(path, 'utf8'));
    assert.equal(decision.specified, true); assert.equal(decision.error, undefined);
    // Judge the delivered location: an existing topic owns its replies even
    // when the model labels a short exchange inline.
    const plan = { connector: 'feishu', sourceRouteId: 'synthetic', target: {
      ...summary, conversationKind: test.thread ? 'thread' : 'main', messageId: test.id,
    } };
    const delivered = resolveAmbientFeishuReplyPlan({ options: { sourceContext: {
      feishuParticipation: 'ambient', feishuReplyPlacementVersion: 1,
    } } }, plan, [{ type: 'message', role: 'assistant', content: await readFile(path, 'utf8') }]);
    assert.equal(delivered?.target.conversationKind, test.mode === 'inline' ? 'main' : 'thread');
    if (test.thread) assert.equal(delivered.target.threadId, summary.threadId);
    if (!test.silent) { assert.ok(decision.text); assert.equal(decision.noTextReason, undefined); }
    if (test.ids) assert.deepEqual([...decision.requestIds].sort(), [...test.ids].sort());
    const events = result.stdout.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    assert.equal(events.filter(e => e.type === 'item.completed' && ['command_execution', 'mcp_tool_call', 'file_change', 'web_search'].includes(e.item?.type)).length, 0, 'simulation must not execute tools');
    test.check(decision);
  } catch (e) { error = e.message; }
  results.push({ id: test.id, passed: !error, ...(error ? { error } : {}), decision });
  console.log(JSON.stringify(results.at(-1)));
}
await writeFile(join(out, 'results.json'), JSON.stringify(results, null, 2));
console.log(`Evidence: ${out}`);
assert.equal(results.filter(r => !r.passed).length, 0, 'Review failed cases and raw outputs; this smoke is not a statistical reliability guarantee.');
