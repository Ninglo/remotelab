import { readdir, readFile, stat, mkdir, rm, open } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { CONFIG_DIR, CHAT_RUNS_DIR } from '../lib/config.mjs';
import { writeDurableJson, readRecord, serialQueue } from '../lib/durable-records.mjs';
import { estimateUsageCost } from '../lib/model-pricing.mjs';
import { REVIEW_MODEL, REVIEW_RULE_VERSION, REVIEW_RULE_HASH, fingerprint, segmentPrompt, redactReviewText, validateReviewResult } from './prompt-review-policy.mjs';
import { reviewPromptBatch } from './prompt-review-model.mjs';

export const PROMPT_REVIEW_ROOT = join(CONFIG_DIR, 'prompt-review');
const captureRoot = join(CONFIG_DIR, 'prompt-captures');
const versionKey = fingerprint(`${REVIEW_MODEL}:${REVIEW_RULE_VERSION}:${REVIEW_RULE_HASH}`).slice(0, 16);
const root = join(PROMPT_REVIEW_ROOT, versionKey);
const rank = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
const now = () => new Date().toISOString();
const names = async dir => { try { return await readdir(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } };
const live = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
const GAP_NOTES = [
  '覆盖本实例所有可取回 Run manifest.prompt、未重复的 modelContext、native-inputs 回执中的提交文本，以及启用后捕获的后台分类/记忆提示。保存的准备文本不证明模型已接受。',
  '不是完整 provider wire 请求审计：Harness 自行加载的 AGENTS/Skill、工具返回、模型内置系统指令、附件二进制、压缩后上下文和历史未保存的后台提示不在覆盖范围，数量未知。',
  '按标题与最多 12,000 字符分段、精确指纹去重；覆盖指内容段全部审完，跨段组合、授权真实性和实际执行后果仍需人工结合原会话核对。无发现不代表安全保证。',
];

export async function captureBackgroundPrompt(session, prompt, operation) {
  const config = await readRecord(join(CONFIG_DIR, 'prompt-review.json'));
  if (!config?.enabled || typeof prompt !== 'string' || !prompt) return;
  const id = fingerprint(`${session.id || ''}:${operation || ''}:${prompt}`);
  try {
    await writeDurableJson(join(captureRoot, `${id}.json`), { sessionId: session.id || '', operation: operation || 'background',
      observedAt: now(), stage: 'prepared_background', prompt });
    await rm(join(PROMPT_REVIEW_ROOT, 'capture-failures', `${id}.json`), { force: true });
  } catch (error) {
    await writeDurableJson(join(PROMPT_REVIEW_ROOT, 'capture-failures', `${id}.json`), {
      kind: 'background', sessionId: session.id || '', reason: 'capture_write_failed', observedAt: now() }).catch(() => {});
    throw error;
  }
}

export async function promptReviewConfig() {
  const config = await readRecord(join(CONFIG_DIR, 'prompt-review.json'));
  return { enabled: config?.enabled === true, concurrency: Math.max(1, Math.min(4, Number(config?.concurrency) || 2)),
    maxBatches: Math.max(1, Math.min(1000, Number(config?.maxBatches) || 30)),
    batchChars: Math.max(12000, Math.min(300000, Number(config?.batchChars) || 180000)),
    batchItems: Math.max(1, Math.min(100, Number(config?.batchItems) || 40)),
    scheduleId: typeof config?.scheduleId === 'string' ? config.scheduleId : '' };
}

export async function scanPromptSources({ runsDir = CHAT_RUNS_DIR, capturesDir = captureRoot } = {}) {
  const sources = [], segments = new Map(), gaps = [];
  function add(ref, text) {
    if (typeof text !== 'string' || !text.length) { gaps.push({ ...ref, reason: 'missing_text' }); return; }
    const parts = segmentPrompt(text);
    const source = { ...ref, id: fingerprint(JSON.stringify(ref)), fingerprint: fingerprint(text), chars: text.length,
      segments: parts.map(({ id, startLine }) => ({ id, startLine })) };
    sources.push(source);
    for (const segment of parts) {
      const entry = segments.get(segment.id) || { ...segment, refs: [] };
      entry.refs.push({ sourceId: source.id, startLine: segment.startLine }); segments.set(segment.id, entry);
    }
  }
  for (const runId of (await names(runsDir)).filter(n => /^run_[a-f0-9]+$/.test(n)).sort()) {
    let manifest;
    try {
      const file = join(runsDir, runId, 'manifest.json');
      if ((await stat(file)).size > 4 * 1024 * 1024) throw Error('source_too_large');
      manifest = JSON.parse(await readFile(file, 'utf8'));
      add({ kind: 'manifest', runId, sessionId: manifest.sessionId || '', field: 'prompt' }, manifest.prompt);
      if (manifest.modelContext && !manifest.prompt?.includes(manifest.modelContext)) {
        add({ kind: 'manifest', runId, sessionId: manifest.sessionId || '', field: 'modelContext' }, manifest.modelContext);
      }
    } catch { gaps.push({ kind: 'manifest', runId, reason: 'unreadable_or_oversized' }); }
    for (const file of (await names(join(runsDir, runId, 'native-inputs'))).filter(f => /^[a-f0-9]+\.json$/.test(f))) {
      try {
        const path = join(runsDir, runId, 'native-inputs', file);
        if ((await stat(path)).size > 4 * 1024 * 1024) throw Error('source_too_large');
        const receipt = JSON.parse(await readFile(path, 'utf8'));
        if (receipt.state === 'rejected') continue;
        const input = JSON.parse(receipt.fingerprint);
        add({ kind: 'native-input', runId, sessionId: manifest?.sessionId || '', file,
          delivery: receipt.state === 'accepted' ? 'accepted' : 'uncertain' }, input.text);
      } catch { gaps.push({ kind: 'native-input', runId, file, reason: 'unreadable_or_oversized' }); }
    }
  }
  for (const file of (await names(capturesDir)).filter(f => /^[a-f0-9]{64}\.json$/.test(f))) {
    try {
      const path = join(capturesDir, file);
      if ((await stat(path)).size > 4 * 1024 * 1024) throw Error('source_too_large');
      const capture = JSON.parse(await readFile(path, 'utf8'));
      add({ kind: 'background', sessionId: capture.sessionId || '', file, operation: capture.operation, delivery: 'prepared' }, capture.prompt);
    } catch { gaps.push({ kind: 'background', file, reason: 'unreadable_or_oversized' }); }
  }
  for (const file of await names(join(PROMPT_REVIEW_ROOT, 'capture-failures'))) {
    const failure = await readRecord(join(PROMPT_REVIEW_ROOT, 'capture-failures', file));
    if (failure) gaps.push(failure);
  }
  return { sources, segments, gaps, scannedAt: now() };
}

export async function claimPromptReviewLock(directory = PROMPT_REVIEW_ROOT) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'worker.lock');
  try {
    const handle = await open(path, 'wx', 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: now() })); await handle.close();
    return async () => { await rm(path, { force: true }); };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner;
    try { owner = await readRecord(path); } catch {}
    if (owner?.pid && live(owner.pid)) return null;
    // An incomplete owner write is given time to finish, without a polling loop.
    if (!owner?.pid && Date.now() - (await stat(path)).mtimeMs < 30000) return null;
    await rm(path, { force: true });
    return claimPromptReviewLock(directory);
  }
}

export async function runPromptReview({ review = reviewPromptBatch, maxBatches, config: suppliedConfig, onProgress = () => {} } = {}) {
  const config = suppliedConfig || await promptReviewConfig();
  if (!config.enabled) return { state: 'disabled' };
  const release = await claimPromptReviewLock();
  if (!release) return { state: 'already_running' };
  let snapshot;
  try {
    const scan = await scanPromptSources();
    await mkdir(root, { recursive: true, mode: 0o700 });
    const results = new Map();
    for (const file of (await names(join(root, 'results'))).filter(f => /^[a-f0-9]{64}\.json$/.test(f))) {
      try { const row = await readRecord(join(root, 'results', file)); if (row) results.set(row.id, row); } catch {}
    }
    // A crash may have spent provider tokens without returning a receipt. Keep
    // the durable admission as unknown usage, and retry its unfinished inputs.
    for (const file of await names(join(root, 'attempts'))) {
      const path = join(root, 'attempts', file), attempt = await readRecord(path);
      if (attempt?.state !== 'started') continue;
      await writeDurableJson(path, { ...attempt, state: 'interrupted', completedAt: now() });
      for (const id of attempt.segments || []) {
        const prior = results.get(id);
        if (prior?.state === 'reviewed') continue;
        const attempts = (prior?.attempts || 0) + 1;
        const row = { id, state: 'failed', attempts, error: 'interrupted_usage_unknown',
          retryAt: new Date(Date.now() + attempts * 15 * 60000).toISOString() };
        results.set(id, row); await writeDurableJson(join(root, 'results', `${id}.json`), row);
      }
    }
    snapshot = { version: 1, model: REVIEW_MODEL, ruleVersion: REVIEW_RULE_VERSION, ruleHash: REVIEW_RULE_HASH,
      scannedAt: scan.scannedAt, startedAt: now(), state: 'running', notes: GAP_NOTES, sources: scan.sources, gaps: scan.gaps };
    const commit = serialQueue();
    const checkpoint = () => commit(async () => {
      snapshot.rows = [...scan.segments.values()].map(s => {
        const row = results.get(s.id);
        return { id: s.id, chars: s.text.length, refs: s.refs, state: row?.state || 'pending',
          severity: row?.state === 'reviewed' ? row.findings.reduce((a, f) => rank[f.severity] > rank[a] ? f.severity : a, 'none') : null,
          findings: row?.findings || [], attempts: row?.attempts || 0, error: row?.error || '', reviewedAt: row?.reviewedAt || '' };
      });
      // Attempt records survive model/parse failures and are counted once across restarts.
      const attempts = [];
      for (const file of await names(join(root, 'attempts'))) {
        const attempt = await readRecord(join(root, 'attempts', file)); if (attempt) attempts.push(attempt);
      }
      snapshot.usage = { calls: attempts.length, measuredCalls: attempts.filter(a => a.usage).length,
        inputTokens: attempts.reduce((n, a) => n + (a.usage?.inputTokens || 0), 0),
        cachedInputTokens: attempts.reduce((n, a) => n + (a.usage?.cachedInputTokens || 0), 0),
        outputTokens: attempts.reduce((n, a) => n + (a.usage?.outputTokens || 0), 0),
        elapsedMs: attempts.reduce((n, a) => n + (a.elapsedMs || 0), 0),
        estimatedCostUsd: attempts.reduce((n, a) => n + (a.cost?.estimatedCostUsd || 0), 0),
        estimatedCalls: attempts.filter(a => a.cost).length, costSource: 'repository model-pricing estimate; not an invoice', billedCostUsd: null };
      snapshot.updatedAt = now();
      await writeDurableJson(join(root, 'snapshot.json'), snapshot);
    });
    await checkpoint();
    const eligible = [...scan.segments.values()].filter(s => {
      const row = results.get(s.id);
      return row?.state !== 'reviewed' && (row?.attempts || 0) < 3 && (!row?.retryAt || Date.parse(row.retryAt) <= Date.now());
    });
    const batches = []; let batch = [], chars = 0;
    for (const segment of eligible) {
      if (batch.length && (batch.length >= config.batchItems || chars + segment.text.length > config.batchChars)) {
        batches.push(batch); batch = []; chars = 0;
      }
      batch.push(segment); chars += segment.text.length;
    }
    if (batch.length) batches.push(batch);
    const limit = maxBatches ?? config.maxBatches;
    let next = 0;
    await Promise.all(Array.from({ length: config.concurrency }, async () => {
      while (next < Math.min(limit, batches.length)) {
        const index = next++, items = batches[index], started = Date.now();
        const attemptId = `${Date.now()}-${process.pid}-${index}`;
        const attemptPath = join(root, 'attempts', `${attemptId}.json`);
        const intent = { model: REVIEW_MODEL, ruleVersion: REVIEW_RULE_VERSION, ruleHash: REVIEW_RULE_HASH,
          inputFormat: 'numbered-lines-v1', startedAt: new Date(started).toISOString(),
          segments: items.map(s => s.id), state: 'started', usage: null };
        await writeDurableJson(attemptPath, intent);
        let response, error, parsed = [];
        try {
          response = await review(items);
          const object = JSON.parse(response.text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
          if (!Array.isArray(object.results)) throw Error('Review response missing results');
          parsed = object.results;
        } catch (e) { error = e; response ||= e.reviewUsage; }
        const usage = response?.usage ? { inputTokens: (response.usage.input || 0) + (response.usage.cacheRead || 0),
          cachedInputTokens: response.usage.cacheRead || 0, outputTokens: response.usage.output || 0 } : null;
        await writeDurableJson(attemptPath, { ...intent, model: response?.model || REVIEW_MODEL,
          ruleVersion: REVIEW_RULE_VERSION, ruleHash: REVIEW_RULE_HASH, responseId: response?.responseId || '',
          startedAt: new Date(started).toISOString(), completedAt: now(), elapsedMs: Date.now() - started,
          usage, cost: usage ? estimateUsageCost({ model: REVIEW_MODEL, ...usage }) : null,
          segments: items.map(s => s.id), state: error ? 'failed' : 'completed' });
        for (const segment of items) {
          const attempts = (results.get(segment.id)?.attempts || 0) + 1; let row;
          try {
            if (error) throw error;
            const matching = parsed.filter(r => r.id === segment.id);
            if (matching.length !== 1) throw Error('Missing or duplicate review result');
            row = { ...validateReviewResult(matching[0], segment), attempts, reviewedAt: now(), attemptId };
          } catch (validationError) {
            // Never persist provider/model errors verbatim: they can contain credentials.
            const messages = { 'Empty evidence': 'empty_evidence', 'Invalid finding or evidence location': 'invalid_evidence_location',
              'Missing or duplicate review result': 'missing_or_duplicate_result', 'Invalid result schema or missing segment': 'invalid_schema' };
            row = { id: segment.id, state: 'failed', attempts, error: error ? 'model_or_json_failure' : messages[validationError.message] || 'invalid_result',
              retryAt: new Date(Date.now() + attempts * 15 * 60000).toISOString(), attemptId };
          }
          results.set(row.id, row);
          await writeDurableJson(join(root, 'results', `${row.id}.json`), row);
        }
        await checkpoint();
        onProgress({ batch: index + 1, plannedBatches: Math.min(limit, batches.length), totalBatches: batches.length,
          reviewed: [...results.values()].filter(r => r.state === 'reviewed').length });
      }
    }));
    snapshot.state = snapshot.rows.some(r => r.state !== 'reviewed') ? 'incomplete' : 'completed';
    snapshot.finishedAt = now(); await checkpoint();
    return summarizePromptReview(snapshot, config);
  } finally { await release(); }
}

export function summarizePromptReview(snapshot, config) {
  if (!snapshot) return { state: 'not_started', config, model: REVIEW_MODEL, ruleVersion: REVIEW_RULE_VERSION, notes: GAP_NOTES };
  const rows = snapshot.rows || [], byId = new Map(rows.map(r => [r.id, r]));
  const fullyReviewed = snapshot.sources.filter(s => s.segments.every(p => byId.get(p.id)?.state === 'reviewed')).length;
  return { state: snapshot.state, model: snapshot.model, ruleVersion: snapshot.ruleVersion, ruleHash: snapshot.ruleHash,
    config, scannedAt: snapshot.scannedAt, updatedAt: snapshot.updatedAt, startedAt: snapshot.startedAt, finishedAt: snapshot.finishedAt,
    notes: snapshot.notes, usage: snapshot.usage,
    coverage: { sources: snapshot.sources.length, fullyReviewed, partialOrPending: snapshot.sources.length - fullyReviewed,
      uniqueSegments: rows.length, reviewed: rows.filter(r => r.state === 'reviewed').length,
      pending: rows.filter(r => r.state === 'pending').length, failed: rows.filter(r => r.state === 'failed').length,
      deduplicatedOccurrences: rows.reduce((n, r) => n + r.refs.length - 1, 0),
      unreadable: snapshot.gaps.length, gaps: snapshot.gaps.slice(0, 100), unknownWireCoverage: true,
      bySource: ['manifest','native-input','background'].map(kind => ({ kind, sources: snapshot.sources.filter(s => s.kind === kind).length })) },
    risks: Object.fromEntries(Object.keys(rank).map(severity => [severity, rows.filter(r => r.state === 'reviewed' && r.severity === severity).length])) };
}

export async function readPromptReview({ offset = 0, severity = '', state = '', sourceId = '' } = {}) {
  const [snapshot, config] = await Promise.all([readRecord(join(root, 'snapshot.json')), promptReviewConfig()]);
  const summary = summarizePromptReview(snapshot, config);
  let owner; try { owner = await readRecord(join(PROMPT_REVIEW_ROOT, 'worker.lock')); } catch {}
  summary.workerRunning = Boolean(owner?.pid && live(owner.pid));
  if (summary.state === 'running' && !summary.workerRunning) summary.state = 'interrupted';
  const sourceMap = new Map((snapshot?.sources || []).map(s => [s.id, s]));
  const rows = (snapshot?.rows || []).filter(r => (!severity || r.severity === severity) && (!state || r.state === state)
    && (!sourceId || r.refs.some(ref => ref.sourceId === sourceId)))
    .sort((a, b) => (rank[b.severity] || 0) - (rank[a.severity] || 0) || a.id.localeCompare(b.id));
  const start = Math.max(0, Number.parseInt(offset, 10) || 0);
  return { ...summary, total: rows.length, offset: start, rows: rows.slice(start, start + 50).map(row => {
    const ref = row.refs.find(r => r.sourceId === sourceId) || row.refs[0], source = sourceMap.get(ref.sourceId);
    return { ...row, refs: undefined, occurrences: row.refs.length, source: { id: source.id, kind: source.kind,
      sessionId: source.sessionId, runId: source.runId, field: source.field, delivery: source.delivery, startLine: ref.startLine } };
  }) };
}

export async function readPromptReviewSource(id) {
  if (!/^[a-f0-9]{64}$/.test(id || '')) return null;
  const snapshot = await readRecord(join(root, 'snapshot.json'));
  const source = snapshot?.sources.find(s => s.id === id);
  if (!source) return null;
  let text;
  if (source.kind === 'manifest') text = (await readRecord(join(CHAT_RUNS_DIR, source.runId, 'manifest.json')))?.[source.field];
  if (source.kind === 'native-input') text = JSON.parse((await readRecord(join(CHAT_RUNS_DIR, source.runId, 'native-inputs', source.file))).fingerprint).text;
  if (source.kind === 'background') text = (await readRecord(join(captureRoot, source.file)))?.prompt;
  if (typeof text !== 'string') return { error: '原文已不可取回；先前审阅不代表当前内容。' };
  if (fingerprint(text) !== source.fingerprint) return { error: '原文已变化，等待下一轮补审。' };
  return { id, kind: source.kind, sessionId: source.sessionId, runId: source.runId, fingerprint: source.fingerprint,
    text: redactReviewText(text, text), redacted: true, ruleVersion: snapshot.ruleVersion };
}

// A native Schedule script gate calls this short admission action. The durable
// worker is bounded and process-locked, and never admits a conversational Agent.
export async function launchPromptReview() {
  if (!(await promptReviewConfig()).enabled) return { state: 'disabled' };
  await mkdir(PROMPT_REVIEW_ROOT, { recursive: true, mode: 0o700 });
  let owner; try { owner = await readRecord(join(PROMPT_REVIEW_ROOT, 'worker.lock')); } catch {}
  if (owner?.pid && live(owner.pid)) return { state: 'already_running' };
  const log = await open(join(PROMPT_REVIEW_ROOT, 'worker.log'), 'w', 0o600);
  try {
    const child = spawn(process.execPath, [new URL('../scripts/prompt-review.mjs', import.meta.url).pathname],
      { detached: true, env: { ...process.env }, stdio: ['ignore', log.fd, log.fd] });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref(); return { state: 'launched', pid: child.pid };
  } finally { await log.close(); }
}
