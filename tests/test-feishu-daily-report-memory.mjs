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
  // Keep publication verification available, but never feed reports to the
  // social-reaction model or let it answer factual questions.
  const verdict = await classifyFeishuQuickParticipation(question, { key: 'fixture', projectMemory: memory,
    fetchImpl: async (_url, req) => {
      const sent = JSON.parse(req.body);
      assert.equal(sent.state.project_memory, undefined);
      assert.deepEqual(Object.keys(sent.questions), ['reaction']);
      return { ok: true, json: async () => ({ answers: { binaryAnswer: { choice: 'yes', probabilities: { yes: .99 } } } }) };
    } });
  assert.equal(verdict.emojiType, null);
  console.log('test-feishu-daily-report-memory: ok');
} finally { await rm(home, { recursive: true, force: true }); }
