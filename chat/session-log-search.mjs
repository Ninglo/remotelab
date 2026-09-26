import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CHAT_HISTORY_DIR, CONFIG_DIR } from '../lib/config.mjs';
import { stripHiddenBlocks } from '../lib/reply-selection.mjs';
import { buildLangSmithCaseNavigationHref, buildSessionNavigationHref } from '../lib/session-navigation.mjs';
import { getLangSmithCaseStatus, readLangSmithCaseConfig } from '../lib/langsmith-case-link.mjs';
import { loadSessionsMeta } from './session-meta-store.mjs';

const VERSION = 2;
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

function frequencies(text) {
  const counts = new Map();
  for (const term of terms(text)) counts.set(term, (counts.get(term) || 0) + 1);
  return counts;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
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
  const cache = new Map();
  let refreshPromise;

  async function indexSession(session) {
    const dir = join(historyDir, session.id);
    let meta;
    try { meta = await readJson(join(dir, 'meta.json')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; meta = { latestSeq: 0 }; }
    const seq = Number.isSafeInteger(meta.latestSeq) ? Math.max(0, meta.latestSeq) : 0;
    const stamp = `${seq}:${meta.lastEventAt || ''}`;
    const path = join(indexDir, `${session.id}.json`);
    let stored = cache.get(session.id);
    if (!stored) {
      try { stored = await readJson(path); } catch { /* Missing/corrupt derived data can be rebuilt. */ }
    }
    if (stored?.version !== VERSION || !Number.isSafeInteger(stored.seq)
      || stored.seq > seq || (stored.seq === seq && stored.stamp !== stamp)
      || !Array.isArray(stored.counts)) stored = { version: VERSION, seq: 0, counts: [], length: 0 };
    if (stored.stamp !== stamp) {
      const counts = new Map(stored.counts);
      let length = stored.length;
      for (let start = stored.seq + 1; start <= seq; start += 16) {
        const numbers = Array.from({ length: Math.min(16, seq - start + 1) }, (_, i) => start + i);
        const messages = await Promise.all(numbers.map(async number => {
          const event = await readJson(join(dir, 'events', `${String(number).padStart(9, '0')}.json`));
          if (event.type !== 'message' || !['user', 'assistant'].includes(event.role)) return null;
          let content = event.content || '';
          if (event.bodyRef) {
            if (!/^evt_\d+_content$/.test(event.bodyRef)) throw new Error('Invalid message body reference');
            content = await readFile(join(dir, 'bodies', `${event.bodyRef}.txt`), 'utf8');
          }
          return { content, weight: event.role === 'user' ? 2 : 1 };
        }));
        for (const message of messages) {
          if (!message) continue;
          const tokens = terms(message.content);
          length += tokens.length * message.weight;
          for (const term of tokens) counts.set(term, (counts.get(term) || 0) + message.weight);
        }
      }
      stored = { version: VERSION, seq, stamp, length, counts: [...counts] };
      const temp = `${path}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(stored), { mode: 0o600 });
      await rename(temp, path);
    }
    cache.set(session.id, stored);
    return { session, body: new Map(stored.counts), length: stored.length,
      title: frequencies(session.name || ''),
      summary: frequencies([session.description || '', JSON.stringify(session.workSummary || '')].join('\n')) };
  }

  async function refresh() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      const sessions = (await list()).filter(session => /^[0-9a-f]{32}$/.test(session.id)
        && (!session.internalRole?.trim() || session.internalRole.trim() === 'scheduled_execution'));
      const ids = new Set(sessions.map(session => session.id));
      for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);
      await mkdir(indexDir, { recursive: true, mode: 0o700 });
      let incomplete = false;
      const docs = await mapConcurrent(sessions, 4, async session => {
        try { return await indexSession(session); }
        catch (error) {
          incomplete = true;
          console.warn(`[session-log-search] Cannot index ${session.id}: ${error.code || error.name}`);
          return null;
        }
      });
      return { docs: docs.filter(Boolean), incomplete };
    })().finally(() => { refreshPromise = null; });
    return refreshPromise;
  }

  return async function search(query) {
    const text = String(query || '').trim();
    if (!text || text.length > 1000) {
      const error = new Error('Search query must contain 1–1000 characters');
      error.statusCode = 400;
      throw error;
    }
    const tokens = [...new Set(terms(text, { query: true }))].slice(0, 128);
    if (!tokens.length) return { sessions: [], incomplete: false };
    const { docs, incomplete } = await refresh();
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
      return { session: doc.session, score };
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score
      || String(b.session.updatedAt || '').localeCompare(String(a.session.updatedAt || ''))
      || a.session.id.localeCompare(b.session.id)).slice(0, 3);
    let config;
    let configError = false;
    try { config = await readCaseConfig(); } catch { configError = true; }
    const sessions = await Promise.all(ranked.map(async ({ session }) => {
      let snapshot;
      let unavailable = configError;
      try { snapshot = await latestCase(session.id, config); } catch { unavailable = true; }
      return { id: session.id, title: session.name || '未命名会话', sessionUrl: sessionHref(session.id),
        langsmithUrl: snapshot?.url || '', langsmithEntryUrl: snapshot?.url ? caseHref(session.id) : '',
        langsmithKind: snapshot?.kind || '',
        langsmithStatus: snapshot?.url ? 'available' : unavailable ? 'unavailable' : snapshot?.status || 'missing' };
    }));
    return { sessions, incomplete };
  };
}

export const searchSessionLogs = createSessionLogSearch();
