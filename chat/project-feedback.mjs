import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, open, link, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clean = (v, max) => typeof v === 'string' && v.trim().length <= max ? v.trim() : null;
export function feedbackUrl(v) {
  if (!v) return '';
  try { const u = new URL(v); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : ''; }
  catch { return ''; }
}
function normalize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {
    client_id: clean(input.client_id, 36), subproject_id: clean(input.subproject_id ?? '', 100),
    usefulness: clean(input.usefulness ?? '', 20), comment: clean(input.comment ?? '', 4000),
    example: clean(input.example ?? '', 2000), target_title: clean(input.target_title ?? '', 300),
    target_url: clean(input.target_url ?? '', 2048), related_feedback_id: clean(input.related_feedback_id ?? '', 600),
  };
  if (Object.values(out).some(v => v === null) || !UUID.test(out.client_id)
    || !['', 'useful', 'not_useful'].includes(out.usefulness)
    || (!out.comment && !out.usefulness) || (out.target_url && !feedbackUrl(out.target_url))) return null;
  out.client_id = out.client_id.toLowerCase();
  out.target_url = feedbackUrl(out.target_url);
  return out;
}
const fault = (code, message) => Object.assign(new Error(message), { code });
function at(value) {
  const d = typeof value === 'number' ? new Date(value * 1000) : new Date(value || NaN);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}
function legacyRecord(raw, classification, themes) {
  const source = raw.source || {}, theme = themes.get(classification?.theme_id);
  return {
    id: raw.id, subproject_id: classification?.primary_subproject_id || '',
    bucket: classification?.bucket || 'unassigned_feedback',
    author: raw.actor?.name || '身份待核实', person_id: raw.actor?.personId || '',
    created_at: at(raw.eventTime), kind: raw.kind,
    comment: raw.observedText || raw.text || '', usefulness: '', emoji: raw.emojiType || '', example: '',
    target_title: source.title || '', target_quote: source.quote || raw.context?.originalBotMessage?.content || '',
    source_url: feedbackUrl(source.url), target_url: feedbackUrl(source.originalMessageUrl),
    source_session_id: /^[a-f0-9]{32}$/.test(source.sessionId || '') ? source.sessionId : '',
    related_feedback_id: '', analysis: raw.interpretation?.assessment || '',
    classification_reason: classification?.reason || '', pending_candidate: classification?.pending_candidate || '',
    theme: theme?.title || '', suggested_direction: theme?.suggested_direction || '',
    review_state: raw.state || '', change_state: 'unknown',
  };
}
function websiteRecord(raw, classification, themes, review) {
  const theme = themes.get(classification?.theme_id);
  return {
    id: raw.id, subproject_id: classification?.primary_subproject_id || '',
    bucket: classification?.bucket || 'unassigned_feedback', author: raw.author?.name || '身份待核实',
    person_id: raw.author?.id || '', created_at: at(raw.created_at), kind: 'website_feedback',
    comment: raw.comment || '', usefulness: raw.usefulness || '', emoji: '', example: '',
    target_title: raw.target?.title || '', target_quote: '', source_url: '', target_url: feedbackUrl(raw.target?.url),
    source_session_id: '', related_feedback_id: '', analysis: review?.reason || classification?.analysis || '', classification_reason: classification?.reason || '',
    pending_candidate: '', theme: theme?.title || '', suggested_direction: theme?.suggested_direction || '',
    target_revision: raw.target?.revision || '', review_state: review?.status || classification?.review_state || 'recorded', change_state: 'unknown',
  };
}
function webRecord(raw, classification, themes) {
  return {
    ...websiteRecord({ ...raw, created_at: raw.received_at, author: raw.actor,
      target: { title: raw.target_title, url: raw.target_url } }, classification, themes),
    subproject_id: classification?.primary_subproject_id ?? raw.subproject_id,
    bucket: classification?.bucket || (raw.subproject_id ? 'assigned_feedback' : 'unassigned_feedback'),
    person_id: raw.actor?.person_id || '', kind: 'monitor_feedback', example: raw.example,
    related_feedback_id: raw.related_feedback_id, review_state: classification ? (classification.review_state || 'reviewed') : 'collected',
  };
}

export function createProjectFeedbackStore({ configFile = join(CONFIG_DIR, 'feedback-board.json'),
  defaultWriteDir = join(CONFIG_DIR, 'project-feedback'), now = () => new Date().toISOString() } = {}) {
  async function snapshot() {
    let config;
    try { config = JSON.parse(await readFile(configFile, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { configured: false, projects: [], records: [], gaps: [], themes: [], writeDir: defaultWriteDir }; throw error; }
    const gaps = [];
    async function source(key) {
      if (!config[key]) { gaps.push({ source: key, code: 'not_configured' }); return null; }
      try { return JSON.parse(await readFile(config[key], 'utf8')); }
      catch (error) { gaps.push({ source: key, code: error.code || 'invalid_json' }); return null; }
    }
    const [review, ledger, qianyan] = await Promise.all([source('reviewFile'), source('legacyFile'), source('qianyanFile')]);
    const classifications = new Map((review?.classifications || []).map(c => [c.source_record_id, c]));
    const themes = new Map((review?.themes || []).map(t => [t.id, t]));
    const records = new Map();
    const websiteReviews = new Map((qianyan?.feedback_reviews || []).map(r => [r.feedback_id, r]));
    for (const raw of ledger?.records || []) records.set(raw.id, legacyRecord(raw, classifications.get(raw.id), themes));
    for (const raw of [...qianyan?.stage_feedback || [], ...qianyan?.selection_feedback || [], ...qianyan?.analysis_feedback || []]) {
      if (!records.has(raw.id)) records.set(raw.id, websiteRecord(raw, classifications.get(raw.id), themes, websiteReviews.get(raw.id)));
    }
    const writeDir = config.writeDir || defaultWriteDir;
    const files = await readdir(writeDir).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const name of files.filter(n => /^[a-f0-9]{64}\.json$/.test(n))) {
      try { const raw = JSON.parse(await readFile(join(writeDir, name), 'utf8'));
        records.set(raw.id, webRecord(raw, classifications.get(raw.id), themes));
      } catch (error) { gaps.push({ source: 'web_feedback', code: error.code || 'invalid_json' }); }
    }
    for (const id of classifications.keys()) if (!records.has(id)) gaps.push({ source: 'classified_record', code: 'source_unavailable' });
    const projects = (review?.subprojects || []).map(p => ({ id: p.subproject_id, name: p.name,
      directions: p.suggested_directions || [], classification_status: p.registry_status || 'trial',
      themes: [...themes.values()].filter(t => t.subproject_id === p.subproject_id).map(t => ({
        id: t.id, title: t.title, direction: t.suggested_direction, change_state: 'suggested',
      })) }));
    const projectIds = new Set(projects.map(p => p.id));
    const list = [...records.values()];
    for (const r of list) if (r.bucket === 'assigned_feedback' && !projectIds.has(r.subproject_id)) {
      r.bucket = 'unassigned_feedback'; r.subproject_id = '';
    }
    list.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '') || a.id.localeCompare(b.id));
    return { configured: Boolean(review), projects, records: list, gaps, writeDir,
      review_at: review?.created_at || null, generated_at: now(), themes: [...themes.values()] };
  }
  async function read(subproject) {
    const data = await snapshot();
    const extras = ['unassigned_feedback', 'related_context', 'paused_history'];
    if (subproject !== undefined) {
      const project = data.projects.find(p => p.id === subproject);
      if (!project && !extras.includes(subproject)) throw fault('NOT_FOUND', '子项目不存在。');
      return { configured: data.configured, project: project || null, gaps: data.gaps,
        records: data.records.filter(r => project ? r.bucket === 'assigned_feedback' && r.subproject_id === subproject : r.bucket === subproject),
        review_at: data.review_at };
    }
    const counts = Object.fromEntries(extras.map(key => [key, data.records.filter(r => r.bucket === key).length]));
    return { configured: data.configured, generated_at: data.generated_at, review_at: data.review_at, gaps: data.gaps,
      counts: { ...counts, assigned_feedback: data.records.filter(r => r.bucket === 'assigned_feedback').length, raw_records: data.records.length },
      projects: data.projects.map(p => {
        const own = data.records.filter(r => r.bucket === 'assigned_feedback' && r.subproject_id === p.id);
        return { ...p, feedback_count: own.length, pending_analysis_count: own.filter(r => r.review_state === 'collected').length,
          latest_at: own[0]?.created_at || null, coverage: own.length ? 'sample' : 'not_represented', current_unresolved_count: null };
      }) };
  }
  async function submit(actor, input) {
    const payload = normalize(input);
    if (!payload) throw fault('INVALID_INPUT', '填写有用／没用，或说明具体意见；检查文字和链接。');
    if (!actor?.person_id) throw fault('UNAUTHENTICATED', '需要登录后提交反馈。');
    const data = await snapshot();
    if (!data.configured) throw fault('NOT_CONFIGURED', '子项目列表暂未配置。');
    if (payload.subproject_id && !data.projects.some(p => p.id === payload.subproject_id)) throw fault('INVALID_INPUT', '子项目不存在。');
    const related = payload.related_feedback_id && data.records.find(r => r.id === payload.related_feedback_id);
    if (payload.related_feedback_id && (!related || related.bucket === 'paused_history')) throw fault('INVALID_INPUT', '引用的反馈不存在或属于暂停历史。');
    const digest = createHash('sha256').update(`${actor.person_id}\0${payload.client_id}`).digest('hex');
    const pathname = join(data.writeDir, digest + '.json');
    const repeat = async () => {
      const raw = JSON.parse(await readFile(pathname, 'utf8'));
      if (JSON.stringify(normalize(raw)) !== JSON.stringify(payload)) throw fault('FEEDBACK_CONFLICT', '提交编号已用于其他内容，请保留原记录并重新提交修改稿。');
      return { record: webRecord(raw, null, new Map()), duplicate: true };
    };
    try { return await repeat(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(data.writeDir, { recursive: true, mode: 0o700 });
    const raw = { id: 'project_fb_' + randomUUID(), ...payload,
      actor: { person_id: actor.person_id, name: actor.name || '', identity_id: actor.identity_id || '' },
      received_at: now(), kind: 'monitor_feedback', review_state: 'collected' };
    const temp = join(data.writeDir, '.' + randomUUID() + '.tmp');
    try {
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(raw) + '\n'); await file.sync(); } finally { await file.close(); }
      try { await link(temp, pathname); } catch (error) { if (error.code === 'EEXIST') return await repeat(); throw error; }
    } finally { await unlink(temp).catch(() => {}); }
    return { record: webRecord(raw, null, new Map()), duplicate: false };
  }
  return { read, submit };
}
