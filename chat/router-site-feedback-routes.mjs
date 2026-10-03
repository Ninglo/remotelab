import { createHash, randomUUID } from 'crypto';
import { mkdir, readdir, readFile, link, unlink, open } from 'fs/promises';
import { join } from 'path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { readBody } from '../lib/utils.mjs';

const SITE = 'qianyan-workbench';
const feedbackDir = join(CONFIG_DIR, 'site-feedback', SITE);
const targetKinds = new Set(['event', 'source', 'page', 'site', 'daily']);
const usefulSignals = new Set(['useful', 'not_useful']);
const nextSteps = new Set(['skip', 'follow', 'read', 'test']);
const tags = new Set([
  'duplicate', 'off-topic', 'weak-evidence', 'misleading', 'wrong-fact',
  'missing-context', 'valuable-source', 'worth-testing', 'should-follow',
  'source-request', 'ui-issue',
]);
let lastReceivedMs = 0;

function text(value, max) {
  return typeof value === 'string' && value.trim().length <= max ? value.trim() : null;
}

function httpsUrl(value) {
  if (value === undefined || value === '') return '';
  const normalized = text(value, 2048);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
}

function score(value) {
  return value === undefined || value === null || value === ''
    ? null : Number.isInteger(value) && value >= 1 && value <= 5 ? value : undefined;
}

function normalizeFeedback(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const clientId = text(input.client_id, 36);
  const target = input.target;
  const scores = input.scores;
  const priority = score(scores?.priority);
  const relevance = score(scores?.relevance);
  const novelty = score(scores?.novelty);
  const usefulness = input.usefulness == null ? '' : input.usefulness;
  const nextStep = input.next_step == null || input.next_step === '' ? '' : input.next_step;
  const comment = input.comment == null ? '' : text(input.comment, 1500);
  const evidenceUrl = httpsUrl(input.evidence_url);
  const title = text(target?.title, 300);
  const id = text(target?.id, 128);
  const url = httpsUrl(target?.url);
  const revision = target?.revision == null ? '' : text(target.revision, 128);
  const displayVersion = input.display_version == null ? '' : text(input.display_version, 128);
  const feedbackTags = input.tags == null ? [] : input.tags;
  if (!clientId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)
    || revision === null || displayVersion === null
    || !targetKinds.has(target?.kind) || !id || !title || url === null
    || priority === undefined || relevance === undefined || novelty === undefined
    || usefulness !== '' && !usefulSignals.has(usefulness)
    || !nextSteps.has(nextStep) && nextStep !== '' || comment === null || evidenceUrl === null
    || !Array.isArray(feedbackTags) || feedbackTags.length > 6
    || feedbackTags.some((tag) => !tags.has(tag)) || new Set(feedbackTags).size !== feedbackTags.length
    || (priority === null && relevance === null && novelty === null && !usefulness && !nextStep && !comment && !feedbackTags.length)) return null;
  return {
    client_id: clientId.toLowerCase(),
    target: { kind: target.kind, id, title, url, revision },
    display_version: displayVersion,
    scores: { priority, relevance, novelty },
    usefulness,
    next_step: nextStep,
    tags: feedbackTags,
    comment,
    evidence_url: evidenceUrl,
  };
}

function recordPath(personId, clientId) {
  const digest = createHash('sha256').update(`${personId}\0${clientId}`).digest('hex');
  return join(feedbackDir, `${digest}.json`);
}

async function saveFeedback(personId, input) {
  const pathname = recordPath(personId, input.client_id);
  await mkdir(feedbackDir, { recursive: true, mode: 0o700 });
  let existing = null;
  try { existing = JSON.parse(await readFile(pathname, 'utf8')); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (existing) {
    if (JSON.stringify(normalizeFeedback(existing)) !== JSON.stringify(input)) {
      const error = new Error('Idempotency key reused with different feedback');
      error.code = 'FEEDBACK_CONFLICT';
      throw error;
    }
    return { record: existing, duplicate: true };
  }
  lastReceivedMs = Math.max(Date.now(), lastReceivedMs + 1);
  const record = {
    id: `fb_${randomUUID()}`,
    site: SITE,
    person_id: personId,
    received_at: new Date(lastReceivedMs).toISOString(),
    ...input,
  };
  const temporary = join(feedbackDir, `.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`);
      await handle.sync();
    } finally { await handle.close(); }
    try { await link(temporary, pathname); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const concurrent = JSON.parse(await readFile(pathname, 'utf8'));
      if (JSON.stringify(normalizeFeedback(concurrent)) !== JSON.stringify(input)) {
        const conflict = new Error('Idempotency key reused with different feedback');
        conflict.code = 'FEEDBACK_CONFLICT';
        throw conflict;
      }
      return { record: concurrent, duplicate: true };
    }
  } finally { await unlink(temporary).catch(() => {}); }
  return { record, duplicate: false };
}

async function listFeedback(personId) {
  const names = await readdir(feedbackDir).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  const records = await Promise.all(names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).map(async (name) => {
    try { return JSON.parse(await readFile(join(feedbackDir, name), 'utf8')); }
    catch { return null; }
  }));
  const own = records.filter((record) => record?.person_id === personId)
    .sort((a, b) => b.received_at.localeCompare(a.received_at));
  const quickState = {};
  for (const record of own) {
    if (!usefulSignals.has(record.usefulness)) continue;
    const key = `${record.target?.kind}:${record.target?.id}`;
    if (!quickState[key]) quickState[key] = {
      usefulness: record.usefulness, id: record.id, received_at: record.received_at,
      revision: record.target.revision || '', display_version: record.display_version || '',
    };
  }
  return { feedback: own.slice(0, 50), quick_state: quickState };
}

function requestOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return `${proto === 'https' || proto === 'http' ? proto : req.socket?.encrypted ? 'https' : 'http'}://${host}`;
}

export async function handleSiteFeedbackRoutes({ req, res, pathname, authSession, writeJson }) {
  if (pathname !== '/api/site-feedback') return false;
  if (!['GET', 'POST'].includes(req.method)) {
    writeJson(res, 405, { error: 'Method not allowed' }); return true;
  }
  const personId = authSession?.personId;
  if (!personId) { writeJson(res, 403, { error: '需要登录后提交反馈。' }); return true; }
  if (req.method === 'GET') {
    try { writeJson(res, 200, { site: SITE, ...await listFeedback(personId) }); }
    catch (error) { console.error('[site-feedback] read failed:', error); writeJson(res, 503, { error: '反馈暂时无法读取。' }); }
    return true;
  }
  const suppliedOrigin = req.headers.origin;
  if ((suppliedOrigin && suppliedOrigin !== requestOrigin(req))
    || req.headers['sec-fetch-site'] === 'cross-site'
    || (!suppliedOrigin && !req.headers.authorization)) {
    writeJson(res, 403, { error: '请求来源不符。' }); return true;
  }
  if (!/^application\/json(?:;|$)/i.test(String(req.headers['content-type'] || ''))) {
    writeJson(res, 415, { error: '需要 JSON 请求。' }); return true;
  }
  try {
    const input = normalizeFeedback(JSON.parse(await readBody(req, 16 * 1024)));
    if (!input) { writeJson(res, 400, { error: '反馈字段无效，请检查评分、文字和链接。' }); return true; }
    const { record, duplicate } = await saveFeedback(personId, input);
    writeJson(res, duplicate ? 200 : 201, { id: record.id, received_at: record.received_at, duplicate });
  } catch (error) {
    if (error instanceof SyntaxError) writeJson(res, 400, { error: 'JSON 格式无效。' });
    else if (error?.code === 'BODY_TOO_LARGE') writeJson(res, 413, { error: '反馈超过 16 KB。' });
    else if (error?.code === 'FEEDBACK_CONFLICT') writeJson(res, 409, { error: '这条反馈已保存过，请重新提交修改后的内容。' });
    else { console.error('[site-feedback] write failed:', error); writeJson(res, 503, { error: '反馈暂时无法保存，请稍后重试。' }); }
  }
  return true;
}
