import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const home = await mkdtemp(join(tmpdir(), 'prompt-calibration-test-'));
setIsolatedTestHome(home);
const { CONFIG_DIR, CHAT_RUNS_DIR } = await import('../lib/config.mjs');
const { validateReviewResult, fingerprint, REVIEW_STORAGE_KEY, REVIEW_RULE_HASH, needsRiskCalibration, credentialEvidence, retainCredentialEvidence } = await import('../chat/prompt-review-policy.mjs');
const { runPromptReview, readPromptReview } = await import('../chat/prompt-review.mjs');
const put = async (p, x) => { await mkdir(join(p, '..'), { recursive: true }); await writeFile(p, JSON.stringify(x)); };
const segment = { id: 'test', text: 'Concrete evidence line.' };
const finding = { severity: 'critical', category: 'destructive', startLine: 1, endLine: 1, reason: '测试说明', recommendation: '测试建议' };
const result = f => validateReviewResult({ id: segment.id, findings: [{ ...finding, ...f }] }, segment).findings[0];

test('unsupported severity cannot promote uncertainty, expiry or a quotation into critical harm', () => {
  assert.equal(result({}).severity, 'low');
  assert.equal(result({ evidenceBasis: 'direct', immediacy: 'expired' }).severity, 'low');
  assert.equal(result({ evidenceBasis: 'historical', immediacy: 'unknown' }).severity, 'medium');
  assert.equal(result({ category: 'disclosure', evidenceBasis: 'historical', immediacy: 'unknown' }).severity, 'medium');
  assert.equal(result({ category: 'disclosure', evidenceBasis: 'direct', immediacy: 'unknown', exposureBasis: 'authorized_use' }).severity, 'medium');
  assert.equal(result({ category: 'disclosure', evidenceBasis: 'direct', immediacy: 'unknown', exposureBasis: 'unintended_audience' }).severity, 'high');
  assert.equal(result({ evidenceBasis: 'direct', immediacy: 'active' }).severity, 'high');
  assert.equal(result({ evidenceBasis: 'direct', immediacy: 'active', criticalBasis: 'imminent_irreversible_harm' }).severity, 'critical');
});

test('fixed credential evidence retains a missed short literal without treating IDs or placeholders as credentials', () => {
  const s = { text: '设备连接记录\n密码 1\n' };
  const f = credentialEvidence(s); assert.equal(f.severity, 'medium'); assert.equal(f.startLine, 2);
  assert.equal(f.evidence, '密码 [REDACTED]');
  assert.equal(credentialEvidence({ text: 'remotelab feishu message.send --key request-123456789' }), null);
  assert.equal(credentialEvidence({ text: 'password=YOUR_PASSWORD' }), null);
  assert.equal(credentialEvidence({ text: 'password=[REDACTED]' }), null);
  assert.equal(credentialEvidence({ text: '密码是否有效未知' }), null);
  const row = retainCredentialEvidence({ state: 'reviewed', findings: [] }, s);
  assert.equal(row.findings.length, 1); assert.equal(retainCredentialEvidence(row, s), row);
});

test('calibration reuses screening, prioritizes old severe findings and retains failed and superseded evidence', async () => {
  const severeText = 'Old severe fixture', ordinaryText = 'Already screened ordinary fixture';
  const severeId = fingerprint(severeText), ordinaryId = fingerprint(ordinaryText);
  const root = join(CONFIG_DIR, 'prompt-review', REVIEW_STORAGE_KEY), path = join(root, 'results', severeId + '.json');
  await put(join(CONFIG_DIR, 'prompt-review.json'), { enabled: true });
  await put(join(CHAT_RUNS_DIR, 'run_aa', 'manifest.json'), { prompt: severeText });
  await put(join(CHAT_RUNS_DIR, 'run_bb', 'manifest.json'), { prompt: ordinaryText });
  const old = { id: severeId, state: 'reviewed', findings: [{ ...finding, evidence: severeText }], attempts: 1, reviewedAt: '2026-01-01T00:00:00Z' };
  await put(path, old);
  await put(join(root, 'results', ordinaryId + '.json'), { id: ordinaryId, state: 'reviewed', findings: [], attempts: 1 });
  let seen = [];
  const config = { enabled: true, concurrency: 1, maxBatches: 1, batchItems: 40, batchChars: 180000 };
  await runPromptReview({ config, review: async rows => { seen = rows.map(r => r.id); throw Error('synthetic provider failure'); } });
  assert.deepEqual(seen, [severeId], 'ordinary screened segments are not billed for a full replay');
  let saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(saved.findings[0].severity, 'critical'); assert.equal(saved.calibration.attempts, 1);
  let view = await readPromptReview(); assert.equal(view.calibration.pending, 1); assert.equal(view.calibration.failed, 1); assert.equal(view.risks.critical, 1);
  saved.calibration.retryAt = '2020-01-01T00:00:00Z'; await put(path, saved);
  await runPromptReview({ config, review: async rows => ({ text: JSON.stringify({ results: rows.map(s => ({ id: s.id, findings: [], contextNotes: ['仅缺上下文，不是直接越权证据。'] })) }) }) });
  saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(saved.reviewRuleHash, REVIEW_RULE_HASH); assert.equal(needsRiskCalibration(saved), false);
  assert.deepEqual(saved.previousReview.findings, old.findings); assert.equal(saved.previousReview.calibration.attempts, 1);
  view = await readPromptReview(); assert.equal(view.calibration.pending, 0); assert.equal(view.calibration.carriedForward, 1); assert.equal(view.calibration.contextOnly, 1);
  assert.equal(view.risks.critical, 0); assert.equal(view.rows.find(r => r.id === severeId).previousReview.severity, 'critical');
  await rm(home, { recursive: true, force: true });
});
