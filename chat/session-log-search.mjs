import { canReferenceOwnSession, hrBrowserRestricted, sessionAccessFilter } from './session-access.mjs';
import { getAuthReadSnapshot } from '../lib/auth-config.mjs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CHAT_HISTORY_DIR, CONFIG_DIR } from '../lib/config.mjs';
import { ByteBudgetCache, cacheBudgetBytes } from '../lib/byte-budget-cache.mjs';
import { isFinalAssistantMessage, isReplyMessage } from '../lib/assistant-message-phase.mjs';
import { stripHiddenBlocks } from '../lib/reply-selection.mjs';
import { buildLangSmithCaseNavigationHref, buildSessionNavigationHref } from '../lib/session-navigation.mjs';
import { getLangSmithCaseStatus, readLangSmithCaseConfig } from '../lib/langsmith-case-link.mjs';
import { loadSessionsMeta } from './session-meta-store.mjs';

const VERSION = 3;
const STOP_WORDS = new Set('the a an is are was were to of for in on and or with me my please find session sessions 帮我 找到 查找 相关 关于 之前 现在 一个 一下 会话 历史 记录 请问 能否 怎么 如何'.split(' '));
const normalize = value => stripHiddenBlocks(value).normalize('NFKC').toLowerCase();

function terms(value, { query = false } = {}) {
  const result = [];
  for (const match of normalize(value).matchAll(/[\p{Script=Han}]+|[\p{Script=Latin}\p{N}_]+/gu)) {
    const word = match[0];
    if (/^\p{Script=Han}/u.test(word)) {
      const chars = [...word];
      if (!query || chars.length === 1) result.push(...chars);
      for (let i = 0; i < chars.length - 1; i++) result.push(chars[i] + chars[i + 1]);
    } else result.push(word);
  }
  return result.filter(term => !STOP_WORDS.has(term));
}

function referenceExcerpt(content, tokens, limit) {
  const normalized = normalize(content);
  const positions = tokens.map(token => normalized.indexOf(token)).filter(pos => pos >= 0);
  const start = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 120);
  return `${start ? '…' : ''}${content.slice(start, start + limit)}${content.length > start + limit ? '…' : ''}`;
}

export function rankIndexReferences(sources, query, { allowContent = () => true, limit = 9 } = {}) {
  const tokens = [...new Set(terms(query, { query: true }))].slice(0, 128);
  const tokenSet = new Set(tokens);
  return sources.map(({ title, excerpt, ...source }) => {
    const text = stripHiddenBlocks(excerpt);
    const titleHits = matchingTerms(title, tokenSet).size;
    const bodyHits = matchingTerms(text, tokenSet).size;
    return { ...source, title, score: titleHits * 3 + bodyHits, text };
  }).filter(source => source.score && source.text && allowContent(source.title + '\n' + source.text))
    .sort((a, b) => b.score - a.score).slice(0, limit).map(({ score, text, ...source }) => ({ ...source, excerpt: referenceExcerpt(text, tokens, 1000) }));
}

function matchingTerms(text, queryTerms) {
  return new Set(terms(text).filter(term => queryTerms.has(term)));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

// /new moves the binding, but preserves the old Session's original source.
// This is a retrieval filter within shared instance access, not an ACL.
function privateChatKey(session) {
  const source = session?.sourceContext || {};
  const conversation = session?.conversation;
  const target = conversation?.connector === 'feishu' ? conversation.target : source;
  if ((conversation?.connector || source.connector) !== 'feishu'
    || !['p2p', 'private'].includes(target?.chatType)
    || target.topicId || target.threadId || target.conversationId
    || ['thread', 'document_comment'].includes(target.conversationKind)) return '';
  const chatId = String(target.chatId || '').trim();
  const route = String(conversation?.sourceRouteId || source.sourceRouteId || 'default').trim();
  const tenant = String(target.tenantKey || source.tenantKey || source.sender?.tenantKey || '').trim();
  return chatId && tenant ? JSON.stringify([route, tenant, chatId]) : '';
}

async function mapConcurrent(items, concurrency, fn) {
  let cursor = 0;
  const results = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]);
    }
  }));
  return results;
}

// A disposable, incremental index of visible messages. Never load a million
// tool events into history.mjs's permanent event/body caches just to search.
export function createSessionLogSearch({
  historyDir = CHAT_HISTORY_DIR,
  indexDir = join(CONFIG_DIR, 'cache', 'session-log-search'),
  list = loadSessionsMeta,
  readCaseConfig = readLangSmithCaseConfig,
  latestCase = getLangSmithCaseStatus,
  sessionHref = id => buildSessionNavigationHref(id, { requireAbsolute: true }),
  caseHref = id => buildLangSmithCaseNavigationHref(id, { requireAbsolute: true }),
} = {}) {
  const cache = new ByteBudgetCache(cacheBudgetBytes('REMOTELAB_SESSION_SEARCH_CACHE_MIB', 64),
    entry => entry.estimatedBytes);
  const indexing = new Map();

  async function readMessage(id, number) {
    const dir = join(historyDir, id);
    const event = await readJson(join(dir, 'events', `${String(number).padStart(9, '0')}.json`));
    if (event.type !== 'message' || !['user', 'assistant'].includes(event.role)) return null;
    let content = event.content || '';
    if (event.bodyRef) {
      if (!/^evt_\d+_content$/.test(event.bodyRef)) throw new Error('Invalid message body reference');
      content = await readFile(join(dir, 'bodies', `${event.bodyRef}.txt`), 'utf8');
    }
    return { seq: number, requestId: event.requestId, role: event.role, timestamp: event.timestamp || '',
      content: stripHiddenBlocks(content),
      final: !event.internalOperation && (event.role === 'user' || (!event.channel || event.channel === 'final')
        && isReplyMessage(event) && (!event.phase || isFinalAssistantMessage(event))),
      weight: event.role === 'user' ? 2 : 1 };
  }

  async function indexSession(session) {
    const dir = join(historyDir, session.id);
    let meta;
    try { meta = await readJson(join(dir, 'meta.json')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; meta = { latestSeq: 0 }; }
    const seq = Number.isSafeInteger(meta.latestSeq) ? Math.max(0, meta.latestSeq) : 0;
    const stamp = `${seq}:${meta.lastEventAt || ''}`;
    const path = join(indexDir, `${session.id}.json`);
    let cached = cache.get(session.id);
    let stored = cached?.index;
    let serializedLength = 0;
    if (!cached) {
      try {
        const serialized = await readFile(path, 'utf8');
        stored = JSON.parse(serialized);
        serializedLength = serialized.length;
      } catch (error) {
        // Missing or invalid derived data can be rebuilt from history.
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
    }
    if (stored?.version !== VERSION || !Number.isSafeInteger(stored.seq)
      || stored.seq > seq || (stored.seq === seq && stored.stamp !== stamp)
      || !Array.isArray(stored.counts) || !Array.isArray(stored.postings)) {
      stored = { version: VERSION, seq: 0, counts: [], postings: [], length: 0 };
    }
    if (stored.stamp !== stamp) {
      const counts = new Map(stored.counts);
      const postings = new Map(stored.postings.map(([term, numbers]) => [term, [...numbers]]));
      let length = stored.length;
      for (let start = stored.seq + 1; start <= seq; start += 16) {
        const numbers = Array.from({ length: Math.min(16, seq - start + 1) }, (_, i) => start + i);
        const messages = await Promise.all(numbers.map(number => readMessage(session.id, number)));
        for (const message of messages) {
          if (!message) continue;
          const tokens = terms(message.content);
          length += tokens.length * message.weight;
          for (const term of tokens) counts.set(term, (counts.get(term) || 0) + message.weight);
          for (const term of new Set(tokens)) {
            if (!postings.has(term)) postings.set(term, []);
            postings.get(term).push(message.seq);
          }
        }
      }
      stored = { version: VERSION, seq, stamp, length, counts: [...counts], postings: [...postings] };
      const serialized = JSON.stringify(stored);
      const temp = `${path}.${randomUUID()}.tmp`;
      await writeFile(temp, serialized, { mode: 0o600 });
      await rename(temp, path);
      serializedLength = serialized.length;
      cached = null;
    }
    if (!cached) {
      // Include the overhead of decoded strings, arrays and their numeric slots.
      cache.set(session.id, { index: stored, estimatedBytes: serializedLength * 6 });
    }
    return stored;
  }

  async function refresh(sessions, tokens, includePostings) {
    await mkdir(indexDir, { recursive: true, mode: 0o700 });
    let incomplete = false;
    const docs = await mapConcurrent(sessions, 4, async session => {
      try {
        if (!indexing.has(session.id)) {
          indexing.set(session.id, indexSession(session).finally(() => indexing.delete(session.id)));
        }
        const stored = await indexing.get(session.id);
        // Ranking needs document lengths and the query terms only. Holding
        // every decoded index until ranking finishes otherwise scales with the
        // entire archive even when the read cache has a byte budget.
        return { session, length: stored.length,
          body: new Map(stored.counts.filter(([term]) => tokens.has(term))),
          postings: includePostings ? new Map(stored.postings.filter(([term]) => tokens.has(term))) : null,
          title: matchingTerms(session.name || '', tokens),
          summary: matchingTerms([session.description || '', JSON.stringify(session.workSummary || '')].join('\n'), tokens) };
      } catch (error) {
        incomplete = true;
        console.warn(`[session-log-search] Cannot index ${session.id}: ${error.code || error.name}`);
        return null;
      }
    });
    return { docs: docs.filter(Boolean), incomplete };
  }

  return async function search(query, { scope = 'all', sessionId = '', authSession = null,
    excludeRequestId, allowContent = () => true } = {}) {
    const text = String(query || '').trim();
    if (!text || text.length > 1000) {
      const error = new Error('Search query must contain 1–1000 characters');
      error.statusCode = 400;
      throw error;
    }
    const personalContext = scope === 'personal-context';
    if (!['all', 'private-chat', 'personal-context'].includes(scope)) {
      throw Object.assign(new Error('Unknown history search scope'), { statusCode: 400 });
    }
    if (personalContext && (!authSession?.personId || authSession.authKind === 'service' || hrBrowserRestricted(authSession))) {
      throw Object.assign(new Error('当前账号无法引用会话历史。'), { statusCode: 403 });
    }
    const document = getAuthReadSnapshot();
    const visible = personalContext ? session => canReferenceOwnSession(authSession, session, document)
      : authSession ? sessionAccessFilter(authSession, document) : () => true;
    const listed = await list();
    const all = listed.filter(visible);
    let selected = all.filter(session => /^[0-9a-f]{32}$/.test(session.id)
      && (!session.internalRole?.trim() || session.internalRole.trim() === 'scheduled_execution'));
    const ids = new Set(listed.map(session => session.id));
    for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);
    if (scope === 'private-chat') {
      const key = privateChatKey(all.find(session => session.id === sessionId));
      if (!key) throw Object.assign(new Error('private-chat search requires a Session with a known Feishu private-chat source'), { statusCode: 400 });
      selected = selected.filter(session => privateChatKey(session) === key);
    }
    const coverage = scope === 'private-chat'
      ? { scope, sourceSessionId: sessionId, searchedSessionCount: selected.length } : {};
    const tokens = [...new Set(terms(text, { query: true }))].slice(0, 128);
    if (!tokens.length) return { sessions: [], incomplete: false, ...coverage };
    let { docs, incomplete } = await refresh(selected, new Set(tokens), scope !== 'all');
    const averageLength = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, docs.length) || 1;
    const idf = new Map(tokens.map(token => {
      const count = docs.filter(doc => doc.title.has(token) || doc.summary.has(token) || doc.body.has(token)).length;
      return [token, Math.log(1 + (docs.length - count + 0.5) / (count + 0.5))];
    }));
    const totalWeight = [...idf.values()].reduce((sum, value) => sum + value, 0);
    const ranked = docs.map(doc => {
      let score = 0;
      let covered = 0;
      for (const token of tokens) {
        const weight = idf.get(token);
        const tf = doc.body.get(token) || 0;
        if (tf || doc.title.has(token) || doc.summary.has(token)) covered += weight;
        score += weight * ((doc.title.has(token) ? 8 : 0) + (doc.summary.has(token) ? 3 : 0)
          + tf * 2.2 / (tf + 1.2 * (0.65 + 0.35 * doc.length / averageLength)));
      }
      score *= covered / totalWeight;
      if (normalize(doc.session.name).includes(normalize(text))) score += totalWeight * 5;
      return { session: doc.session, postings: doc.postings, score };
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score
      || String(b.session.updatedAt || '').localeCompare(String(a.session.updatedAt || ''))
      || a.session.id.localeCompare(b.session.id)).slice(0, 3);
    let config;
    let configError = false;
    if (scope === 'all') {
      try { config = await readCaseConfig(); } catch { configError = true; }
    }
    const sessions = await Promise.all(ranked.map(async ({ session, postings }) => {
      if (scope !== 'all') {
        const scores = new Map();
        for (const token of tokens) {
          for (const seq of postings.get(token) || []) scores.set(seq, (scores.get(seq) || 0) + idf.get(token));
        }
        const numbers = [...scores].sort((a, b) => b[1] - a[1] || b[0] - a[0])
          .slice(0, personalContext ? 9 : 3).map(([seq]) => seq);
        const matches = (await Promise.all(numbers.map(async seq => {
          try {
            const message = await readMessage(session.id, seq);
            if (!message) { incomplete = true; return null; }
            if (personalContext && (!message.final || !message.content
                || (excludeRequestId && session.id === sessionId && message.requestId === excludeRequestId)
                || !allowContent((session.name || '') + '\n' + message.content))) return null;
            const excerpt = referenceExcerpt(message.content, tokens, 480);
            return { seq, role: message.role, timestamp: message.timestamp, excerpt,
              eventPath: `/api/sessions/${session.id}/events?filter=all&afterSeq=${seq - 1}&limit=1` };
          } catch { incomplete = true; return null; }
        }))).filter(Boolean).slice(0, 3);
        return { id: session.id, title: session.name || '未命名会话', sessionUrl: sessionHref(session.id), matches };
      }
      let snapshot;
      let unavailable = configError;
      try { snapshot = await latestCase(session.id, config); } catch { unavailable = true; }
      return { id: session.id, title: session.name || '未命名会话', sessionUrl: sessionHref(session.id),
        langsmithUrl: snapshot?.url || '', langsmithEntryUrl: snapshot?.url ? caseHref(session.id) : '',
        langsmithKind: snapshot?.kind || '',
        langsmithStatus: snapshot?.url ? 'available' : unavailable ? 'unavailable' : snapshot?.status || 'missing' };
    }));
    return { sessions, incomplete, ...coverage };
  };
}

export const searchSessionLogs = createSessionLogSearch();
