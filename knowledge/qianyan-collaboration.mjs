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

export function createQianyanCollaboration({ configDir, documentsPath, publicDataPath, corpusPath, now = () => new Date().toISOString() }) {
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
    if (!['selection', 'analysis'].includes(s)) throw new CollaborationError('评价环节无效'); return s;
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
      counts: { useful: votes.filter(v => v.usefulness === 'useful').length, not_useful: votes.filter(v => v.usefulness === 'not_useful').length }, visibility: 'company' };
  }
  async function addComment(person, input) {
    const t = await target(input.target), body = text(input.comment, 4000), s = stage(input.stage, t.kind);
    const evidence = input.evidence_url ? canonicalSubmissionUrl(input.evidence_url) : '';
    if (!body) throw new CollaborationError('请写一句评价或补充');
    return mutate(state => receipt(state, person, input, () => {
      if (input.parent_id && !state.comments.some(c => c.id === input.parent_id && c.target.kind === t.kind && c.target.id === t.id)) throw new CollaborationError('回复对象不在这篇文章下');
      const row = { id: 'comment_' + randomUUID(), target: t, stage: s, comment: body, evidence_url: evidence,
        parent_id: input.parent_id || '', author: author(person), created_at: now(), visibility: 'company' };
      state.comments.push(row); return { comment: row };
    }));
  }
  async function vote(person, input) {
    const t = await target(input.target), s = stage(input.stage, t.kind);
    if (!['useful', 'not_useful', ''].includes(input.usefulness)) throw new CollaborationError('评价值无效');
    return mutate(state => receipt(state, person, input, () => {
      const key = hash(JSON.stringify([person.id, t.kind, t.id, t.revision, s]));
      const row = { id: 'vote_' + key.slice(0, 20), target: t, stage: s, usefulness: input.usefulness, author: author(person), created_at: now(), display_version: text(input.display_version || '', 128) };
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
  async function exportFeedback(person) {
    if (person.auth_kind !== 'service') throw new CollaborationError('此入口供本站整理流程使用', 403);
    const state = await load(), signals = [...state.comments, ...Object.values(state.votes)];
    return { schema_version: 1, submissions: state.submissions,
      selection_feedback: signals.filter(s => s.stage === 'selection'), analysis_feedback: signals.filter(s => s.stage === 'analysis'),
      policy: '人工推荐影响选题与审读优先级；事实可靠性仍由原始证据判断。两类反馈独立保留，未经评测不自动修改策略。' };
  }
  return { listDocuments, readDocument, comments, addComment, vote, reactions, submit, submissions, review, remove, researchQuery, exportFeedback };
}
