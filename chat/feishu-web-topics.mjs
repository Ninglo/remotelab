import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { watch } from 'node:fs';
import vm from 'node:vm';
import { CONFIG_DIR } from '../lib/config.mjs';
import { loadSessionsMeta } from './session-meta-store.mjs';
import { getSession } from './session-manager.mjs';
import { onSessionInvalidation } from './ws-clients.mjs';

const context = vm.createContext({});
vm.runInContext(await readFile(new URL('../static/chat/session-state-model.js', import.meta.url), 'utf8'), context);
const model = context.RemoteLabSessionStateModel;
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const eligible = s => s?.conversation?.connector === 'feishu' && s.conversation.sourceRouteId === 'bot-2'
  && s.conversation.target?.chatType === 'group' && (s.conversation.target.threadId || s.conversation.target.replyInThread || s.conversation.target.conversationKind === 'thread');
export function topicProjection(s, webThreadId) {
  const row = model.getSessionRowStatusInfo(s), status = row?.key === 'unread' ? 'review' : row?.key || 'idle';
  const goal = [...(s.workAwareness?.works || [])].sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)).map(w => clean(w.goal)).find(Boolean);
  const name = clean(s.name), summary = clean(s.description);
  return { sessionId: s.id, webThreadId, name: name && !/^【飞书|^(新会话|未命名话题|Untitled|New session)$/i.test(name) ? name : goal || '新话题',
    summary: summary && !/^inbounds?\s+feishu\b/i.test(summary) ? summary : goal || (status === 'running' ? '正在处理，摘要生成中' : '暂无摘要'),
    status, label: row?.label || '', archived: !!s.archived, sourceUpdatedAt: s.updatedAt || '',
    sessionUrl: '/?session=' + s.id + '&tab=sessions' };
}
export function topicIds(value) {
  const ids = String(value || '').split(',').filter(Boolean);
  if (ids.length > 200 || ids.some(id => !/^[a-zA-Z0-9_-]{1,80}$/.test(id))) throw Object.assign(Error('话题编号无效。'), { status: 400 });
  return [...new Set(ids)];
}
async function bindingsConfig() {
  const value = JSON.parse(await readFile(join(CONFIG_DIR, 'feishu-web-topics.json'), 'utf8'));
  if (value.version !== 1 || typeof value.bindingsFile !== 'string' || !value.bindingsFile.startsWith('/')) throw Error('话题同步尚未配置。');
  if ((await stat(value.bindingsFile)).size > 1024 * 1024) throw Error('话题对应记录过大。');
  return { file: value.bindingsFile, bindings: JSON.parse(await readFile(value.bindingsFile, 'utf8')) };
}
export function createFeishuTopicSource(deps = {}) {
  const sessions = deps.sessions || loadSessionsMeta, session = deps.session || getSession, bindings = deps.bindings || bindingsConfig;
  async function snapshot(ids, changedId = '', previous = null) {
    const config = await bindings(), wanted = new Set(ids);
    const entries = new Map(previous?.entries?.map(e => [e.sessionId, e]) || []);
    const records = changedId && previous ? [{ id: changedId }] : (await sessions()).filter(s => {
      const t = s.conversation?.target;
      return eligible(s) && wanted.has(config.bindings[t?.rootId || t?.messageId]);
    });
    const ambiguous = new Set();
    if (!changedId || !previous) entries.clear();
    for (const record of records) {
      const s = await session(record.id);
      const t = s?.conversation?.target, native = config.bindings[t?.rootId || t?.messageId];
      if (!eligible(s) || typeof native !== 'string' || !wanted.has(native)) { entries.delete(record.id); continue; }
      // A conflicting native binding never selects whichever Session was read last.
      const collision = [...entries.values()].find(e => e.webThreadId === native && e.sessionId !== s.id);
      if (collision) { ambiguous.add(native); entries.delete(collision.sessionId); entries.delete(s.id); continue; }
      if (ambiguous.has(native)) continue;
      entries.set(s.id, topicProjection(s, native));
    }
    return { schema: 3, syncedAt: new Date().toISOString(), sourceConnected: true, entries: [...entries.values()] };
  }
  async function subscribe(ids, emit, fail) {
    let alive = true, busy = false, pending = false, nextId = '', last = null;
    const refresh = id => {
      if (!alive) return;
      if (busy) { pending = true; nextId = ''; return; }
      busy = true;
      void snapshot(ids, id, last).then(data => { if (alive) { last = data; emit(data); } }).catch(error => { if (alive) fail(error); }).finally(() => {
        busy = false; if (pending && alive) { pending = false; refresh(nextId); }
      });
    };
    const off = onSessionInvalidation(hint => {
      if (hint.type === 'session_invalidated' && (!last || last.entries.some(e => e.sessionId === hint.sessionId))) refresh(hint.sessionId);
      else if (hint.type === 'sessions_invalidated') refresh('');
    });
    let watcher;
    if (!deps.bindings) { const config = await bindings(); watcher = watch(dirname(config.file), (_, name) => { if (String(name) === config.file.split('/').at(-1)) refresh(''); }); watcher.on('error', fail); }
    refresh('');
    return () => { alive = false; off(); watcher?.close(); };
  }
  return { snapshot, subscribe };
}
export const feishuTopicSource = createFeishuTopicSource();
