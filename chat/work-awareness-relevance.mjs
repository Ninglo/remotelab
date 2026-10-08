import { createHash } from 'node:crypto';

const clean = (value, limit = 1500) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const state = session => session?.workAwareness || {};
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const noise = new Set(['工作', '项目', '处理', '这个', '那个', '一个', '我们', '可以', '方案',
  '一下', '然后', '但是', '觉得', '我觉', '确实', '相关', '问题', '内容', '需要', '已经', '其实',
  '这里', '那里', '现在', '之后', '之前', '所以', '还是', '就是', '的是', '的一', '都是', '继续', '续吧',
  '电脑', '显示', '连接', '希望', '什么', '怎么', '这台']);

function tokens(value) {
  const text = clean(value, 1500).toLowerCase();
  const out = text.match(/[a-z0-9_./:-]{3,}/g) || [];
  for (const run of text.match(/[\u4e00-\u9fff]+/g) || []) {
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
  }
  return new Set(out.filter(token => !noise.has(token)));
}

// Index existing task records and cumulative summaries, never conversational
// filler or transport headers. Summaries are retrieval clues, not acceptance.
export function workSearchEntries(sessions) {
  return sessions.filter(session => !session.internalRole).flatMap(session => {
    const works = (state(session).works || []).filter(work => work.goal && work.status !== 'cancelled');
    const summary = session.workSummary;
    const items = works.length ? works : summary?.goal ? [{
      id: 'summary_' + session.id, goal: clean(summary.goal, 240), status: 'recorded',
      source: { kind: 'session-work-summary' },
      results: [{ result: clean(summary.summary, 360), artifacts: (summary.rawMaterials || []).slice(0, 5),
        methods: (summary.reusablePatterns || []).slice(0, 5), acceptance: 'not-asserted' }],
      // A read receipt says how far someone read, not when the summary changed.
      updatedAt: session.updatedAt || '',
    }] : [];
    return items.map(work => ({ ...work, sessionId: session.id, sessionName: clean(session.name, 120),
      archived: session.archived === true,
      fingerprint: hash([work.id, work.version, work.goal, work.object, work.status, work.results]),
      authority: 'reference-only' }));
  });
}

function searchScope(sessions, { sessionId, query, object }) {
  const session = sessions.find(entry => entry.id === sessionId);
  const active = (state(session).works || []).filter(work => work.status === 'active').at(-1);
  return { query: tokens(query).size ? clean(query) : active?.goal || session?.workSummary?.goal || '',
    object: clean(object, 500) || active?.object || '' };
}

function searchText(work) {
  return [work.goal, work.object, ...(work.results?.at(-1)?.artifacts || []).slice(0, 5)].filter(Boolean).join(' ');
}

export function candidateWorkFromSessions(sessions, options = {}) {
  const { sessionId = '', projectId = '', limit = 5 } = options;
  const scope = searchScope(sessions, options);
  const queryTokens = tokens(scope.query);
  const entries = workSearchEntries(sessions).filter(entry => entry.sessionId !== sessionId);
  const frequency = new Map();
  for (const entry of entries) for (const token of tokens(searchText(entry))) {
    frequency.set(token, (frequency.get(token) || 0) + 1);
  }
  const namedTopics = [...queryTokens].filter(token => /^[\u4e00-\u9fff]{2}$/.test(token)
    && (frequency.get(token) || 0) <= Math.max(2, entries.length * 0.1)
    && entries.some(entry => entry.sessionName.startsWith(token)));
  const found = [];
  for (const work of entries) {
    const sameObject = scope.object && work.object === scope.object;
    const matched = [...tokens(searchText(work))].filter(token => queryTokens.has(token));
    const informative = matched.filter(token => (frequency.get(token) || 0) < Math.max(3, entries.length * 0.25));
    const specificTerm = informative.some(token => /[a-z]/.test(token) && (token.length >= 8 || /[./:]/.test(token)));
    const namedTopic = informative.some(token => /^[\u4e00-\u9fff]{2}$/.test(token)
      && work.sessionName.includes(token) && frequency.get(token) <= Math.max(2, entries.length * 0.1));
    if (!sameObject && namedTopics.length && !matched.some(token => namedTopics.includes(token))) continue;
    if (!sameObject && informative.length < 2 && !specificTerm && !namedTopic) continue;
    const weight = informative.reduce((sum, token) => sum + Math.log(1 + entries.length / frequency.get(token)), 0);
    const sameProject = projectId && work.projects?.some(project => project.projectId === projectId && project.status === 'confirmed');
    found.push({ ...work, score: sameObject ? 1000 : weight / Math.sqrt(Math.max(1, queryTokens.size))
      * (namedTopics.some(token => work.sessionName.startsWith(token)) ? 4 : 1),
      sameProject: Boolean(sameProject), matchedTerms: informative.slice(0, 8),
      relation: sameObject ? 'same-declared-object' : 'search-candidate',
      reason: sameObject ? '声明的操作对象相同：' + scope.object : '',
      verification: sameObject ? 'declared-object' : 'unreviewed' });
  }
  return found.sort((a, b) => b.score - a.score || Number(b.sameProject) - Number(a.sameProject)
    || String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .filter((entry, index, all) => all.findIndex(other => other.sessionId === entry.sessionId) === index)
    .slice(0, Math.min(10, Math.max(1, Number(limit) || 5)));
}

export function relatedWorkFromSessions(sessions, options = {}) {
  const { sessionId = '', limit = 3 } = options;
  const source = sessions.find(session => session.id === sessionId);
  const review = state(source).relatedReview;
  const entries = workSearchEntries(sessions);
  const reviewed = review && review.requestId === state(source).intents?.at(-1)?.requestId
    ? (review.items || []).flatMap(item => {
      const work = entries.find(entry => entry.sessionId === item.sessionId && entry.id === item.workId);
      return work && work.fingerprint === item.fingerprint ? [{ ...work, relation: item.relation,
        reason: item.reason, verification: 'harness-reviewed', reviewSource: { runId: review.runId,
          requestId: review.requestId, evidenceRefs: review.evidenceRefs } }] : [];
    }) : [];
  // Exact related work requires a declared object. Without one, a second
  // full topic search cannot produce an accepted relation and only adds cost.
  const exact = searchScope(sessions, options).object
    ? candidateWorkFromSessions(sessions, { ...options, limit: 10 }).filter(work => work.verification === 'declared-object')
    : [];
  return [...reviewed, ...exact]
    .filter((entry, index, all) => all.findIndex(other => other.sessionId === entry.sessionId) === index)
    .slice(0, Math.min(3, Math.max(1, Number(limit) || 3)));
}
