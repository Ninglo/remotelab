import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { watch } from 'node:fs';
import vm from 'node:vm';
import { CONFIG_DIR } from '../lib/config.mjs';
import { loadSessionsMeta } from './session-meta-store.mjs';
import { getSession } from './session-manager.mjs';
import { onSessionInvalidation } from './ws-clients.mjs';
import { loadAuthDocument } from '../lib/auth-config.mjs';
import { buildGroupBoards, personNames } from './feishu-web-group-boards.mjs';
import { topicTextView } from './feishu-web-topic-text.mjs';
import { topicDetails } from './feishu-web-topic-details.mjs';

const context = vm.createContext({});
vm.runInContext(await readFile(new URL('../static/chat/session-state-model.js', import.meta.url), 'utf8'), context);
const model = context.RemoteLabSessionStateModel;
const sourceRecords = Symbol('server-only topic records');
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const eligible = s => s?.conversation?.connector === 'feishu' && s.conversation.sourceRouteId === 'bot-2'
  && s.conversation.target?.chatType === 'group' && (s.conversation.target.threadId || s.conversation.target.replyInThread || s.conversation.target.conversationKind === 'thread');
export function topicProjection(s, webThreadId) {
  const row = model.getSessionRowStatusInfo(s), status = row?.key === 'unread' ? 'review' : row?.key || 'idle';
  return { sessionId: s.id, webThreadId, chatId: s.conversation?.target?.chatId, rootId: s.conversation?.target?.rootId || s.conversation?.target?.messageId, ...topicTextView(s, { state: status }),
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
  const read = async file => { if (typeof file !== 'string' || !file.startsWith('/') || (await stat(file)).size > 1024 * 1024) throw Error('群对应记录无法读取。'); return JSON.parse(await readFile(file, 'utf8')); };
  const groups = value.groupsFile ? await read(value.groupsFile) : {}, boards = value.boardPairsFile ? await read(value.boardPairsFile) : { pairs: [] };
  return { artifactsFile: value.artifactsFile, file: value.bindingsFile, watchFiles: [value.bindingsFile, value.groupsFile, value.boardPairsFile, value.artifactsFile].filter(Boolean), bindings: JSON.parse(await readFile(value.bindingsFile, 'utf8')), groups,
    pairs: (boards.pairs || []).filter(p => groups[p.workChatId] && groups[p.discussionChatId]) };
}
export function createFeishuTopicSource(deps = {}) {
  const sessions = deps.sessions || loadSessionsMeta, session = deps.session || getSession, bindings = deps.bindings || bindingsConfig;
  const details=deps.details||topicDetails;
  async function snapshot(ids, changedId = '', previous = null, groupIds = [], includeDetails = true) {
    const config = await bindings(), wanted = new Set(ids), visibleGroups = new Set(groupIds);
    const pairs = (config.pairs || []).filter(p => [p.workChatId, p.discussionChatId].some(id => visibleGroups.has(String(config.groups?.[id]))));
    const boardChats = new Set(pairs.flatMap(p => [p.workChatId, p.discussionChatId]));
    const relevant = s => eligible(s) && (wanted.has(config.bindings[s.conversation.target.rootId || s.conversation.target.messageId]) || boardChats.has(s.conversation.target.chatId));
    const cache = changedId && previous ? new Map(previous[sourceRecords] || []) : new Map();
    const records = changedId && previous ? [{ id: changedId }] : (await sessions()).filter(relevant);
    for (let i = 0; i < records.length; i += 4) await Promise.all(records.slice(i, i + 4).map(async record => {
      const s = await session(record.id); if (relevant(s)) cache.set(s.id, s); else cache.delete(record.id);
    }));
    const entries = new Map(), ambiguous = new Set(), safeBindings = { ...config.bindings };
    for (const s of cache.values()) {
      const root = s.conversation.target.rootId || s.conversation.target.messageId, native = config.bindings[root];
      if (!native || !wanted.has(native)) continue;
      if (ambiguous.has(native)) { delete safeBindings[root]; continue; }
      if (entries.has(native)) { ambiguous.add(native); delete safeBindings[root]; entries.delete(native); continue; }
      entries.set(native, topicProjection(s, native));
    }
    for (const [root, native] of Object.entries(safeBindings)) if (ambiguous.has(native)) delete safeBindings[root];
    const names = pairs.length ? personNames((await loadAuthDocument({ persistMigration: false })).people) : new Map();
    const data = { schema: 3, syncedAt: new Date().toISOString(), sourceConnected: true, entries: [...entries.values()],
      boards: buildGroupBoards(cache, { pairs, groups: config.groups, names, bindings: safeBindings, viewFor: s => topicProjection(s, '') }) };
    if(includeDetails)Object.assign(data,await details(data.entries,config));
    Object.defineProperty(data, sourceRecords, { value: cache }); return data;
  }
  async function subscribe(ids, emit, fail, groupIds = [], includeDetails = true) {
    let alive = true, busy = false, pending = false, nextId = '', last = null;
    const refresh = id => {
      if (!alive) return;
      if (busy) { pending = true; nextId = ''; return; }
      busy = true;
      void snapshot(ids, id, last, groupIds, includeDetails).then(data => { if (alive) { last = data; emit(data); } }).catch(error => { if (alive) fail(error); }).finally(() => {
        busy = false; if (pending && alive) { pending = false; refresh(nextId); }
      });
    };
    const off = onSessionInvalidation(hint => {
      if (hint.type === 'session_invalidated' && (!last || last[sourceRecords]?.has(hint.sessionId))) refresh(hint.sessionId);
      else if (hint.type === 'sessions_invalidated') refresh('');
    });
    let watcher;
    if (!deps.bindings) { const config = await bindings(); watcher = watch(dirname(config.file), (_, name) => { if ((config.watchFiles || [config.file]).some(file => String(name) === file.split('/').at(-1))) refresh(''); }); watcher.on('error', fail); }
    const detailsTimer=setInterval(()=>refresh(''),60000);detailsTimer.unref?.();
    refresh('');
    return () => { alive = false; clearInterval(detailsTimer); off(); watcher?.close(); };
  }
  return { snapshot, subscribe };
}
export const feishuTopicSource = createFeishuTopicSource();
