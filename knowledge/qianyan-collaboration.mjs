import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { query, rpc } from './qianyan.mjs';

export class CollaborationError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const hash = value => createHash('sha256').update(value).digest('hex');
const text = (v, max) => typeof v === 'string' && v.trim().length <= max ? v.trim() : null;
const uuid = v => /^[a-f0-9-]{36}$/i.test(v || '') && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
export const QIANYAN_STAGES = ['general', 'sources', 'selection', 'reading', 'evidence', 'editorial', 'daily', 'tagging', 'knowledge', 'research', 'display', 'analysis'];
const ACTIVITY_EVENTS = ['visible', 'detail_open', 'source_open', 'tag_filter', 'daily_copy', 'audio_play', 'document_open'];

export function canonicalSubmissionUrl(value) {
  let u; try { u = new URL(value); } catch { throw new CollaborationError('请输入完整的 HTTPS 文章链接'); }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.') ||
    /^(localhost|.*\.localhost|.*\.local)$/i.test(u.hostname) || /^[\d.]+$/.test(u.hostname) || u.hostname.includes(':') || u.port && u.port !== '443') {
    throw new CollaborationError('请推荐公开 HTTPS 文章链接');
  }
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|igshid$)/i.test(k)) u.searchParams.delete(k);
  if (u.hostname === 'arxiv.org') u.pathname = '/abs/' + u.pathname.split('/').pop().replace(/\.pdf$/, '').replace(/v\d+$/, '');
  u.searchParams.sort(); return u.toString();
}

export function createQianyanCollaboration({ configDir, documentsPath, publicDataPath, corpusPath, sourceCatalogPath, pipelineMetricsPath, now = () => new Date().toISOString() }) {
  const directory = join(configDir, 'qianyan-collaboration'), path = join(directory, 'state.json');
  let queue = Promise.resolve();
  async function load() {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return { schema_version: 1, comments: [], votes: {}, submissions: [], receipts: {} }; throw e; }
  }
  async function mutate(fn) {
    const result = queue.then(async () => {
      const state = await load(), value = await fn(state);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const tmp = path + '.' + randomUUID();
      await writeFile(tmp, JSON.stringify(state), { mode: 0o600 }); await rename(tmp, path); return value;
    }); queue = result.catch(() => {}); return result;
  }
  async function documents() {
    try {
      const d = JSON.parse(await readFile(documentsPath, 'utf8'));
      if (!Array.isArray(d.documents)) throw new Error('Invalid document catalogue'); return d.documents;
    } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  }
  const docPreview = d => ({ id: d.id, title: d.title, summary: d.summary, revision: d.revision, updated_at: d.updated_at,
    source_refs: d.source_refs || [], versions: (d.versions || []).map(v => ({ revision: v.revision, updated_at: v.updated_at })) });
  async function listDocuments() { return { documents: (await documents()).map(docPreview) }; }
  async function readDocument(id, revision) {
    const d = (await documents()).find(d => d.id === id);
    if (!d) throw new CollaborationError('找不到这篇研究文档', 404);
    const version = !revision || revision === d.revision ? d : (d.versions || []).find(v => v.revision === revision);
    if (!version) throw new CollaborationError('此文档版本不存在', 404);
    return { ...docPreview(d), ...version, current_revision: d.revision, current_updated_at: d.updated_at, visibility: 'internal', is_current: version.revision === d.revision };
  }
  async function target(input) {
    if (!input || !text(input.id, 128)) throw new CollaborationError('缺少评价对象');
    if (input.kind === 'document') {
      const d = await readDocument(input.id, input.revision);
      return { kind: 'document', id: d.id, revision: d.revision, title: d.title };
    }
    const d = JSON.parse(await readFile(publicDataPath, 'utf8'));
    let obj, revision;
    if (input.kind === 'event') { obj = d.events.find(e => e.id === input.id); revision = obj?.revision; }
    else if (input.kind === 'source') obj = (d.external || []).find(e => e.id === input.id);
    else if (input.kind === 'daily') { obj = d.daily.days.find(e => e.date === input.id); if (obj) obj = { ...obj, title: input.id + ' 具身前沿追踪 · 早报' }; revision = obj?.revision; }
    else if (input.kind === 'page') {
      const [kind, ...key] = input.id.split(':');
      const list = { board: d.boards, model: d.models, judgment: d.judgments, debate: d.debates }[kind];
      obj = list?.find(x => x.id === key.join(':'));
    } else if (input.kind === 'site' && input.id === 'qianyan-workbench') obj = { title: '具身前沿追踪' };
    if (!obj) throw new CollaborationError('评价对象不存在', 404);
    revision ||= d.meta.content_revision;
    if (input.revision && input.revision !== revision) throw new CollaborationError('内容已经更新，请刷新后评价', 409);
    return { kind: input.kind, id: input.id, revision, title: obj.title || obj.name || obj.topic };
  }
  const author = p => ({ id: p.id, name: p.name, kind: p.auth_kind === 'service' ? 'agent' : 'employee' });
  function stage(value, kind) {
    const s = value || (kind === 'source' ? 'selection' : 'analysis');
    if (!QIANYAN_STAGES.includes(s)) throw new CollaborationError('评价环节无效'); return s;
  }
  function receipt(s, p, input, fn) {
    if (!uuid(input.client_id)) throw new CollaborationError('提交标识无效');
    const key = hash(p.id + ':' + input.client_id), fingerprint = hash(JSON.stringify(input));
    if (s.receipts[key]) {
      if (s.receipts[key].fingerprint !== fingerprint) throw new CollaborationError('请重新提交修改后的内容', 409);
      return { ...s.receipts[key].result, duplicate: true };
    }
    const result = fn(); s.receipts[key] = { fingerprint, result }; return result;
  }
  async function comments(input, person) {
    const t = await target(input), state = await load();
    const match = x => x.target.kind === t.kind && x.target.id === t.id;
    const rows = state.comments.filter(match).slice(-200);
    const votes = Object.values(state.votes).filter(v => match(v) && v.target.revision === t.revision);
    return { target: t, comments: rows, votes, own_votes: votes.filter(v => v.author.id === person.id),
      feedback_reviews: (state.feedback_reviews || []).filter(r => rows.some(c => c.id === r.feedback_id)),
      counts: { useful: votes.filter(v => v.usefulness === 'useful').length, not_useful: votes.filter(v => v.usefulness === 'not_useful').length }, visibility: 'company' };
  }
  async function addComment(person, input) {
    const t = await target(input.target), body = text(input.comment, 4000), s = stage(input.stage, t.kind);
    let evidence = '';
    if (input.evidence_url) {
      const original = text(input.evidence_url, 2048);
      canonicalSubmissionUrl(original); // Validate without changing a citation's version or section.
      evidence = new URL(original).toString();
    }
    if (!body) throw new CollaborationError('请写一句评价或补充');
    return mutate(state => receipt(state, person, input, () => {
      if (input.parent_id && !state.comments.some(c => c.id === input.parent_id && c.target.kind === t.kind && c.target.id === t.id)) throw new CollaborationError('回复对象不在这篇文章下');
      const row = { id: 'comment_' + randomUUID(), target: t, stage: s, comment: body, evidence_url: evidence,
        display_version: text(input.display_version || '', 128) || '',
        parent_id: input.parent_id || '', author: author(person), created_at: now(), visibility: 'company' };
      state.comments.push(row); return { comment: row };
    }));
  }
  async function vote(person, input) {
    const t = await target(input.target), s = stage(input.stage, t.kind);
    if (!['useful', 'not_useful', ''].includes(input.usefulness)) throw new CollaborationError('评价值无效');
    return mutate(state => receipt(state, person, input, () => {
      const key = hash(JSON.stringify([person.id, t.kind, t.id, t.revision, s]));
      // Keep superseded/withdrawn votes for versioned feedback review, while
      // counts and reactions continue to use only the current vote.
      state.vote_history ||= [];
      if (state.votes[key]) state.vote_history.push({ ...state.votes[key], superseded: true });
      const row = { id: 'vote_' + randomUUID(), target: t, stage: s, usefulness: input.usefulness, author: author(person), created_at: now(), display_version: text(input.display_version || '', 128) || '' };
      if (!input.usefulness) state.vote_history.push({ ...row, withdrawn: true });
      if (input.usefulness) state.votes[key] = row; else delete state.votes[key]; return { vote: row };
    }));
  }
  async function reactions(person) {
    const state = await load(), quick = {};
    for (const v of Object.values(state.votes).filter(v => v.author.id === person.id).sort((a,b) => a.created_at.localeCompare(b.created_at))) {
      quick[v.target.kind + ':' + v.target.id] = { usefulness: v.usefulness, revision: v.target.revision, display_version: v.display_version, id: v.id };
    }
    return { quick_state: quick };
  }
  async function submit(person, input) {
    const url = canonicalSubmissionUrl(text(input.url, 2048)), reason = text(input.reason || '', 2000);
    if (reason === null) throw new CollaborationError('推荐理由过长');
    return mutate(state => receipt(state, person, input, () => {
      let row = state.submissions.find(r => r.canonical_url === url);
      if (!row) { row = { id: 'submission_' + hash(url).slice(0, 20), canonical_url: url, status: 'pending', status_reason: '', item_id: '', created_at: now(), recommendations: [] }; state.submissions.push(row); }
      if (!row.recommendations.some(r => r.author.id === person.id && r.reason === reason)) row.recommendations.push({ author: author(person), reason, created_at: now() });
      return { submission: row };
    }));
  }
  async function submissions() { return { submissions: (await load()).submissions.slice().reverse().slice(0, 200), visibility: 'company' }; }
  async function sourceCatalog() {
    if (!sourceCatalogPath) return { sources: [], visibility: 'company' };
    try { return { ...JSON.parse(await readFile(sourceCatalogPath, 'utf8')), visibility: 'company' }; }
    catch (e) { if (e.code === 'ENOENT') return { sources: [], visibility: 'company' }; throw e; }
  }
  async function sourceProposals() {
    return { proposals: ((await load()).source_proposals || []).slice().reverse().slice(0, 200), visibility: 'company' };
  }
  async function proposeSource(person, input) {
    if (!['source', 'keyword'].includes(input.kind)) throw new CollaborationError('请选择信源或搜索词');
    const raw = text(input.value, input.kind === 'keyword' ? 300 : 2048), reason = text(input.reason || '', 2000);
    if (!raw || reason === null) throw new CollaborationError('请填写信源或搜索词，说明不超过 2000 字');
    const value = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
    const normalized = input.kind === 'source' && /^https?:\/\//i.test(value) ? canonicalSubmissionUrl(value) : value.toLocaleLowerCase('en-US');
    if (/^[a-z]+:\/\//i.test(value) && input.kind === 'source' && !/^https:\/\//i.test(value)) throw new CollaborationError('请使用公开 HTTPS 信源链接或账号名称');
    return mutate(state => receipt(state, person, input, () => {
      state.source_proposals ||= [];
      let row = state.source_proposals.find(r => r.kind === input.kind && r.normalized === normalized);
      if (!row) { row = { id: 'source_proposal_' + hash(input.kind + ':' + normalized).slice(0, 20), kind: input.kind, value, normalized,
        status: 'pending', status_reason: '', config_ref: '', created_at: now(), recommendations: [] }; state.source_proposals.push(row); }
      if (!row.recommendations.some(r => r.author.id === person.id && r.reason === reason)) row.recommendations.push({ author: author(person), reason, created_at: now() });
      return { proposal: row };
    }));
  }
  async function reviewSource(person, input) {
    if (person.auth_kind !== 'service') throw new CollaborationError('请由信源整理流程更新状态', 403);
    const reason = text(input.reason || '', 2000), reference = text(input.config_ref || '', 256);
    if (!['pending', 'reading', 'adopted', 'declined'].includes(input.status) || reason === null || reference === null ||
        ['adopted', 'declined'].includes(input.status) && !reason || input.status === 'adopted' && !reference) throw new CollaborationError('采用时需注明配置位置和理由，暂不采用也需说明理由');
    return mutate(state => {
      const row = (state.source_proposals || []).find(r => r.id === input.id);
      if (!row) throw new CollaborationError('信源建议不存在', 404);
      row.status = input.status; row.status_reason = reason; row.config_ref = reference; row.reviewed_at = now();
      return { proposal: row };
    });
  }
  async function review(person, input) {
    if (person.auth_kind !== 'service') throw new CollaborationError('请由整理流程更新收录状态', 403);
    if (!['pending', 'reading', 'included', 'declined'].includes(input.status) || !text(input.reason || '', 2000) && input.status === 'declined') throw new CollaborationError('状态或理由无效');
    return mutate(state => {
      const row = state.submissions.find(s => s.id === input.id); if (!row) throw new CollaborationError('投稿不存在', 404);
      row.status = input.status; row.status_reason = text(input.reason || '', 2000); row.item_id = text(input.item_id || '', 128);
      row.reviewed_at = now(); return { submission: row };
    });
  }
  async function remove(person, type, id) {
    return mutate(state => {
      const list = type === 'comment' ? state.comments : state.submissions, i = list.findIndex(r => r.id === id);
      if (i < 0) throw new CollaborationError('记录不存在', 404);
      const own = type === 'comment' ? list[i].author.id === person.id : list[i].recommendations.every(r => r.author.id === person.id);
      if (!own) throw new CollaborationError('只能删除自己提交的内容', 403);
      if (type === 'comment' && state.comments.some(c => c.parent_id === id)) { list[i].comment = '（作者已撤回）'; list[i].evidence_url = ''; }
      else list.splice(i, 1); return { removed: id };
    });
  }
  async function researchQuery(name, args) {
    const corpus = JSON.parse(await readFile(corpusPath, 'utf8')), docs = await documents();
    const record = d => ({ id: 'document:' + d.id, revision: d.revision, kind: 'research_document', title: d.title, summary: d.summary,
      date: d.updated_at.slice(0, 10), direction: '', scope: 'internal_editorial', status: 'reviewed_document', visibility: 'internal',
      source: { url: '#/document/' + d.id }, reviewed_at: d.updated_at, evidence_status: 'editorial', source_refs: d.source_refs,
      markdown: d.markdown, search_text: d.title + ' ' + d.markdown, facts: [], gaps: ['文档内的研究判断须结合原始出处和适用条件；同事评价单独读取，不能当事实。'] });
    const combined = { ...corpus, records: [...corpus.records, ...docs.map(record)], history: [...(corpus.history || []), ...docs.flatMap(d => (d.versions || []).map(v => record({ ...d, ...v })))],
      meta: { ...corpus.meta, document_revision: hash(JSON.stringify(docs.map(d => [d.id, d.revision]))).slice(0,16) } };
    return name === 'mcp' ? rpc(combined, args, { visibility: 'internal' }) : query(combined, 'qianyan_' + name, args, { visibility: 'internal' });
  }
  function signals(state) {
    return [...new Map([...(state.vote_history || []), ...state.comments, ...Object.values(state.votes)].map(row => [row.id, row])).values()];
  }
  async function reviewFeedback(person, input) {
    if (person.auth_kind !== 'service') throw new CollaborationError('请由调优流程记录处理与验证结果', 403);
    const reason = text(input.reason, 2000), s = stage(input.stage || 'general');
    if (!reason || !['reviewed', 'applied', 'verified', 'declined'].includes(input.status)) throw new CollaborationError('处理状态和理由无效');
    const changes = input.policy_changes || [], refs = input.evidence_refs || [];
    if (!Array.isArray(changes) || changes.length > 8 || changes.some(c => !text(c.path, 256) || !text(c.before, 128) || !text(c.after, 128) || c.before === c.after) ||
        !Array.isArray(refs) || refs.length > 8 || refs.some(r => !text(r, 512)) ||
        ['applied', 'verified'].includes(input.status) && !changes.length || input.status === 'verified' && (!refs.length || !text(input.run_id, 128))) {
      throw new CollaborationError('调整需记录前后版本，验证需关联回放运行和证据');
    }
    return mutate(state => receipt(state, person, input, () => {
      const signal = signals(state).find(r => r.id === input.feedback_id);
      if (!signal) throw new CollaborationError('反馈不存在', 404);
      const reviews = state.feedback_reviews ||= [], prior = reviews.filter(r => r.feedback_id === signal.id && r.stage === s).at(-1);
      if (input.status === 'verified' && (!prior || !['applied', 'verified'].includes(prior.status) || JSON.stringify(prior.policy_changes) !== JSON.stringify(changes))) throw new CollaborationError('需先记录这次调整，再验证同一组版本');
      const row = { id: 'feedback_review_' + randomUUID(), feedback_id: signal.id, feedback_target: signal.target,
        stage: s, status: input.status, reason, policy_changes: changes, run_id: text(input.run_id || '', 128) || '',
        evidence_refs: refs, reviewer: author(person), reviewed_at: now() };
      reviews.push(row); return { review: row };
    }));
  }
  async function activity(person, input) {
    if (person.auth_kind === 'service') throw new CollaborationError('使用记录仅由登录同事的实际操作产生', 403);
    const t = await target(input.target), display = text(input.display_version || '', 128), label = text(input.label || '', 64);
    if (!ACTIVITY_EVENTS.includes(input.event) || display === null || label === null ||
        ['daily_copy', 'audio_play'].includes(input.event) && t.kind !== 'daily' || input.event === 'document_open' && t.kind !== 'document') throw new CollaborationError('使用事件无效');
    if (label) {
      const data = JSON.parse(await readFile(publicDataPath, 'utf8'));
      const labels = new Set((data.events || []).flatMap(e => [...Object.values(e.tags || {}).flat(), ...Object.values(e.facets || {}).flat(), ...(e.card_topics || [])]));
      if (input.event !== 'tag_filter' || !labels.has(label)) throw new CollaborationError('筛选标签不在当前内容中');
    }
    return mutate(state => receipt(state, person, input, () => {
      const key = hash(JSON.stringify([t.kind, t.id, t.revision, display, input.event, label]));
      state.activity_counts ||= {};
      const row = state.activity_counts[key] ||= { target: t, event: input.event, display_version: display, label, count: 0, first_at: now() };
      row.count++; row.last_at = now();
      // No query text, source body, duration inference, IP or browser fingerprint.
      return { recorded: true };
    }));
  }
  async function observability() {
    const state = await load(), latest = new Map(), feedback = signals(state).filter(r => !r.withdrawn && !r.superseded);
    for (const row of state.feedback_reviews || []) latest.set(row.feedback_id + ':' + row.stage, row);
    const count = values => values.reduce((out, value) => { out[value] = (out[value] || 0) + 1; return out; }, {});
    let pipeline = null;
    if (pipelineMetricsPath) {
      try { pipeline = JSON.parse(await readFile(pipelineMetricsPath, 'utf8')); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    return { stages: QIANYAN_STAGES, feedback_by_stage: count(feedback.map(r => r.stage)),
      reviewed_by_stage: count([...latest.values()].map(r => r.stage)),
      review_status: count([...latest.values()].map(r => r.status)),
      unreviewed: feedback.filter(r => ![...latest.values()].some(v => v.feedback_id === r.id)).length,
      activity_counts: Object.values(state.activity_counts || {}), pipeline,
      interpretation: '展示、展开、打开原文和播放分别计数；操作次数不等于读完或内容质量。旧 analysis 反馈保留待判定环节。', visibility: 'company' };
  }
  async function exportFeedback(person) {
    if (person.auth_kind !== 'service') throw new CollaborationError('此入口供本站整理流程使用', 403);
    const state = await load(), currentSignals = [...state.comments, ...Object.values(state.votes)];
    return { schema_version: 1, submissions: state.submissions, source_proposals: state.source_proposals || [],
      stage_feedback: signals(state), feedback_reviews: state.feedback_reviews || [], activity_counts: Object.values(state.activity_counts || {}),
      selection_feedback: currentSignals.filter(s => s.stage === 'selection'), analysis_feedback: currentSignals.filter(s => s.stage === 'analysis'),
      policy: '人工推荐影响选题与审读优先级；事实可靠性仍由原始证据判断。两类反馈独立保留，未经评测不自动修改策略。' };
  }
  return { listDocuments, readDocument, comments, addComment, vote, reactions, submit, submissions, sourceCatalog, sourceProposals, proposeSource, reviewSource, review, remove, researchQuery, exportFeedback, reviewFeedback, activity, observability };
}
