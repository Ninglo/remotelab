import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'remotelab-jev-report-memory-'));
setIsolatedTestHome(home);
try {
  const { loadDailyReportMemory, normalizeDailyReportMemory } = await import('../connectors/feishu/daily-report-memory.mjs');
  const { normalizeFeishuGroups, resolveFeishuGroupSettings } = await import('../connectors/feishu/group-settings.mjs');
  const { classifyFeishuQuickParticipation } = await import('../connectors/feishu/quick-participation.mjs');
  const { handleMessage } = await import('../scripts/feishu-connector.mjs');
  const { observeSessionMessage, recordSessionObservationDecision } = await import('../chat/session-observations.mjs');
  const { readEventsAfter } = await import('../chat/history.mjs');
  const settings = { reportsDir: join(home, 'daily'), receiptsDir: join(home, 'receipts'), timeZone: 'Asia/Shanghai' };
  await Promise.all([mkdir(settings.reportsDir), mkdir(settings.receiptsDir)]);
  const now = Date.parse('2026-09-30T12:00:00Z');
  const date = '2026-09-30';
  const bodyPath = join(settings.reportsDir, `${date}.md`);
  const receiptPath = join(settings.receiptsDir, `${date}.json`);
  const question = '日报里 OpenWAM 训练归 Auto Research 吗？';
  const body = '## 当前判断\n\nOpenWAM 训练归 Auto Research，已由负责人在原评论确认。[来源](https://example.com/comment)\n\n## 评测\n\nV2V seed 0 已审计，另两组未齐，不能称三 seed 完成。\n\n## 治理\n\n治理重构只是候选方案，负责人明确暂缓。\n';
  let version = 0;
  async function publish(content = body, overrides = {}) {
    const receipt = { ok: true, body_verified: true, dry_run: false, date,
      source: bodyPath, doc_url: 'https://example.com/daily',
      body_sha256: createHash('sha256').update(content).digest('hex'),
      generated_at: new Date(now - 60 * 60 * 1000).toISOString(), ...overrides };
    await writeFile(bodyPath, content);
    await writeFile(receiptPath, JSON.stringify(receipt));
    version++;
    await Promise.all([utimes(bodyPath, version, version), utimes(receiptPath, version, version)]);
    return receipt;
  }
  assert.equal(normalizeDailyReportMemory(false), null);
  assert.throws(() => normalizeDailyReportMemory({ reportsDir: 'relative', receiptsDir: home }), /absolute/);
  assert.throws(() => normalizeDailyReportMemory({ ...settings, timeZone: 'wrong-zone' }), /timeZone/);
  assert.throws(() => normalizeFeishuGroups({ group: { dailyReportMemory: settings } }), /requires jevReactions/);
  const pilot = { participationMode: 'ambient', groupFeed: true, quickReactions: true, jevReactions: true,
    dailyReportMemory: settings };
  const config = { storageDir: home, groups: normalizeFeishuGroups({ group: pilot }) };
  assert.equal(resolveFeishuGroupSettings(config, { chatId: 'group', chatType: 'group' }).dailyReportMemory.reportsDir, settings.reportsDir);
  assert.equal(resolveFeishuGroupSettings(config, { chatId: 'other', chatType: 'group' }).dailyReportMemory, undefined);
  assert.equal(resolveFeishuGroupSettings(config, { chatId: 'group', chatType: 'group', threadId: 'thread' }).dailyReportMemory, undefined);
  assert.equal(await loadDailyReportMemory(settings, question, { now }), null);
  const receipt = await publish();
  const memory = await loadDailyReportMemory(settings, question, { now });
  assert.equal(memory.sources[0].sha256, receipt.body_sha256);
  assert.equal(memory.sources[0].date, date);
  assert.match(memory.excerpts.map(item => item.text).join('\n'), /已由负责人.*来源/);
  assert.equal(await loadDailyReportMemory(settings, 'QYX_UNRELATED_923 是否好了？', { now }), null,
    'an unrelated question must not receive an arbitrary report excerpt');
  await writeFile(bodyPath, body + '\n未发布的新稿。');
  assert.equal(await loadDailyReportMemory(settings, question, { now }), null,
    'local edits must not masquerade as the verified publication');
  for (const override of [{ body_verified: false }, { dry_run: true }, { dry_run: undefined }, { ok: false },
    { source: '/another-instance/report.md' }, { body_sha256: '0'.repeat(64) },
    { generated_at: new Date(now + 1000).toISOString() },
    { generated_at: new Date(now - 49 * 60 * 60 * 1000).toISOString() }]) {
    await publish(body, override);
    assert.equal(await loadDailyReportMemory(settings, question, { now }), null);
  }
  const replacement = body.replace('已由负责人在原评论确认', '今天新增的归属确认');
  await publish(replacement);
  assert.match((await loadDailyReportMemory(settings, question, { now })).excerpts[0].text, /今天新增/,
    'a new publication must invalidate the previous process cache');
  const long = '## OpenWAM\n\nOpenWAM 已完成。' + '补充背景。'.repeat(1000) + '但没有正式审计，不能认定完成。';
  await publish(long);
  assert.equal(await loadDailyReportMemory(settings, question, { now }), null,
    'never truncate a long paragraph before its qualification');
  await publish();
  let requests = 0;
  const verdict = await classifyFeishuQuickParticipation(question, { key: 'fixture',
    includeHandoff: false, newestText: question, projectMemory: memory,
    fetchImpl: async (_url, request) => {
      requests++;
      const sent = JSON.parse(request.body);
      assert.deepEqual(sent.state.project_memory, memory);
      assert.match(sent.questions.binaryAnswer.instructions, /Missing information means none, not No/);
      assert.match(sent.questions.binaryAnswer.instructions, /current changing status/);
      return { ok: true, json: async () => ({ answers: {
        participation: { choice: 'reply', probabilities: { reply: 0.99, silent: 0.01 } },
        binaryAnswer: { choice: 'yes', probabilities: { yes: 0.99, no: 0, none: 0.01 } },
        binaryEvidence: { choice: 'project_snapshot', probabilities: { project_snapshot: 0.99, current_context: 0, insufficient: 0.01 } },
      } }) };
    } });
  assert.equal(requests, 1);
  assert.equal(verdict.emojiType, 'Yes');
  assert.deepEqual(verdict.contextSources, memory.sources);
  const unsupportedLive = await classifyFeishuQuickParticipation('现在 V2V seed 2 跑完了吗？', {
    key: 'fixture', includeHandoff: false, newestText: '现在 V2V seed 2 跑完了吗？', projectMemory: memory,
    fetchImpl: async () => ({ ok: true, json: async () => ({ answers: {
      participation: { choice: 'reply', probabilities: { reply: 0.99, silent: 0.01 } },
      binaryAnswer: { choice: 'no', probabilities: { no: 0.99, yes: 0, none: 0.01 } },
      binaryEvidence: { choice: 'insufficient', probabilities: { insufficient: 0.99, current_context: 0, project_snapshot: 0.01 } },
      workMode: { choice: 'short', probabilities: { short: 0.99, complex: 0.01 } },
    } }) }),
  });
  assert.equal(unsupportedLive.emojiType, null, 'an unsupported high-probability No must be blocked');
  assert.equal(unsupportedLive.workMode, 'complex');
  await classifyFeishuQuickParticipation(question, { key: 'fixture', projectMemory: memory,
    fetchImpl: async (_url, request) => {
      assert.equal(JSON.parse(request.body).state.project_memory, undefined,
        'legacy Jev groups must keep their existing request shape');
      return { ok: true, json: async () => ({ answers: {
        participation: { choice: 'silent', probabilities: { reply: 0.01, silent: 0.99 } },
      } }) };
    } });
  const event = await observeSessionMessage('memory-test', { sourceMessageId: 'memory-source', text: question });
  const saved = await recordSessionObservationDecision('memory-test', 'memory-source', {
    participation: 'reply', workMode: 'reaction', emojiType: 'Yes', contextSources: memory.sources,
  });
  assert.deepEqual(saved.contextSources, memory.sources);
  const history = await readEventsAfter('memory-test', event.eventSeq);
  assert.deepEqual(history.find(item => item.type === 'reaction_decision').contextSources, memory.sources);
  const effects = [];
  const actualQuestion = '日报里 OpenWAM 训练归 Auto Research 吗？';
  const actualDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const actualBodyPath = join(settings.reportsDir, `${actualDate}.md`);
  await writeFile(actualBodyPath, body);
  await writeFile(join(settings.receiptsDir, `${actualDate}.json`), JSON.stringify({ ...receipt,
    date: actualDate, source: actualBodyPath, generated_at: new Date(Date.now() - 1000).toISOString() }));
  const outcome = await handleMessage({ config, storagePaths: {}, botIdentity: { openId: 'bot' } }, {
    chatId: 'group', chatType: 'group', messageType: 'text', messageId: 'memory-reaction',
    messageText: actualQuestion, mentions: [], sender: { senderType: 'user', openId: 'person' },
  }, 'test', {
    observeRemoteLabMessage: async () => ({ sessionId: 'timeline', observation: { eventSeq: 1,
      recent: [{ time: Date.now(), sender: 'Person', text: actualQuestion }] } }),
    classifyJevReaction: async (_context, options) => {
      effects.push('jev');
      assert(options.projectMemory?.sources[0].date === actualDate);
      return { decision: 'reply', workMode: 'reaction', emojiType: 'Yes', contextSources: options.projectMemory.sources };
    },
    recordJevDecision: async (_session, _message, decision) => ({ decision }),
    enqueueJevReaction: async (_runtime, _summary, _session, emojiType) => {
      effects.push(emojiType); return { id: 'delivery' };
    },
    submitRemoteLabRequest: () => { throw new Error('a report-supported binary answer must not start a Harness'); },
  });
  assert.equal(outcome.decision.contextSources[0].date, actualDate);
  assert.deepEqual(effects, ['jev', 'Yes']);
  assert.equal(outcome.runId, undefined);
  assert.deepEqual(JSON.parse(await readFile(receiptPath, 'utf8')).body_sha256, receipt.body_sha256);
  console.log('test-feishu-daily-report-memory: ok');
} finally {
  await rm(home, { recursive: true, force: true });
}
