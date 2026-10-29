import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { watch } from 'node:fs';
import vm from 'node:vm';
import { CONFIG_DIR } from '../lib/config.mjs';
import { loadSessionsMeta } from './session-meta-store.mjs';
import { getSession, acknowledgeSessionResult } from './session-manager.mjs';
import { onSessionInvalidation } from './ws-clients.mjs';
import { loadAuthDocument } from '../lib/auth-config.mjs';
import { buildGroupBoards, personNames, boardGroups, verifiedBoards } from './feishu-web-group-boards.mjs';
import { topicTextView } from './feishu-web-topic-text.mjs';
import { topicDetails } from './feishu-web-topic-details.mjs';
import { nativeTopicBindings } from './feishu-native-topic-ids.mjs';

const context = vm.createContext({});
vm.runInContext(await readFile(new URL('../static/chat/session-state-model.js', import.meta.url), 'utf8'), context);
const model = context.RemoteLabSessionStateModel;
const sourceRecords = Symbol('server-only topic records');
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const eligible = s => s?.conversation?.connector === 'feishu' && s.conversation.sourceRouteId === 'bot-2'
  && s.conversation.target?.chatType === 'group' && (s.conversation.target.threadId || s.conversation.target.replyInThread || s.conversation.target.conversationKind === 'thread');
export function topicProjection(s, webThreadId) {
  const resultTime = new Date(s.lastAssistantMessageAt || '').getTime();
  const row = model.getSessionRowStatusInfo(s), status = row?.key === 'unread' ? 'review' : row?.key || 'idle';
  return { sessionId: s.id, webThreadId, chatId: s.conversation?.target?.chatId, rootId: s.conversation?.target?.rootId || s.conversation?.target?.messageId, ...topicTextView(s, { state: status }),
    displayName: model.getSessionDisplayName(s), rowStatus: row,
    resultAt: Number.isFinite(resultTime) ? new Date(resultTime).toISOString() : '', status, label: row?.label || '', archived: !!s.archived, sourceUpdatedAt: s.updatedAt || '',
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
  const nativeNamespaces = value.nativeNamespacesFile ? await read(value.nativeNamespacesFile) : null;
  return { nativeNamespaces, artifactsFile: value.artifactsFile, file: value.bindingsFile, watchFiles: [value.bindingsFile, value.groupsFile, value.boardPairsFile, value.artifactsFile, value.nativeNamespacesFile].filter(Boolean), bindings: JSON.parse(await readFile(value.bindingsFile, 'utf8')), groups,
    pairs: boards.pairs || [] };
}
export function createFeishuTopicSource(deps = {}) {
  const sessions = deps.sessions || loadSessionsMeta, session = deps.session || (id => getSession(id, { includeTransportSurfaces: false })), bindings = deps.bindings || bindingsConfig;
  const details=deps.details||topicDetails;
  async function snapshot(ids, changedId = '', previous = null, groupIds = [], includeDetails = true) {
    const config = await bindings(), wanted = new Set(ids), visibleGroups = new Set(groupIds);
    const metadata = await sessions();
    config.bindings = await nativeTopicBindings(metadata, ids, config, deps.configDir || CONFIG_DIR);
    const parents = new Map();
    for (const s of metadata) if (eligible(s)) {
      const id = config.bindings[s.conversation.target.rootId || s.conversation.target.messageId];
      if (wanted.has(id)) parents.set(id, parents.has(id) ? null : s);
    }
    for (const s of parents.values()) if (s) {
      const group = config.groups?.[s.conversation.target.chatId]; if (group) visibleGroups.add(String(group));
    }
    const pairs = verifiedBoards(config.pairs || [],config.groups || {}).filter(p => boardGroups(p).some(g => visibleGroups.has(String(config.groups?.[g.chatId]))));
    const boardChats = new Set(pairs.flatMap(p => boardGroups(p).map(g=>g.chatId)));
    const relevant = s => eligible(s) && (wanted.has(config.bindings[s.conversation.target.rootId || s.conversation.target.messageId]) || boardChats.has(s.conversation.target.chatId));
    const incremental = changedId && previous;
    // A periodic/global refresh rechecks membership against current metadata but
    // reuses cached records whose metadata version is unchanged; a deep refresh
    // (no previous snapshot) still rereads every relevant record.
    const versioned = !changedId && previous && previous[sourceRecords];
    const cache = incremental || versioned ? new Map(previous[sourceRecords] || []) : new Map();
    const sameVersion = (cached, meta) => Boolean(cached?.updatedAt) && cached.updatedAt === meta.updatedAt;
    const relevantRecords = metadata.filter(relevant), relevantIds = new Set(relevantRecords.map(s => s.id));
    // Recheck membership on every hint: new topics, deleted topics and changed
    // bindings must still appear/disappear without rereading unrelated records.
    for (const id of cache.keys()) if (!relevantIds.has(id)) cache.delete(id);
    const changed = new Set(Array.isArray(changedId) ? changedId : [changedId]);
    const records = relevantRecords.filter(s => incremental ? changed.has(s.id) || !cache.has(s.id)
      : !versioned || !sameVersion(cache.get(s.id), s));
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
    let alive = true, busy = false, pending = false, fullPending = false, last = null, healthy = false, deepAt = 0;
    const changedIds = new Set();
    let enrichment = null, enriching = false, detailsPending = false, detailsTimer, detailsAt = 0, lastDigest = '';
    const deliver = data => {
      // Activity timestamps change with every tool event. They are not a new
      // visible state; retransmitting entire group boards queues stale frames
      // on slower links. Heartbeats independently preserve the live lease.
      const digest = JSON.stringify(data, (key, value) => ['syncedAt', 'sourceUpdatedAt'].includes(key) ? undefined : value);
      if (digest === lastDigest) return;
      lastDigest = digest; emit(data);
    };
    const publish = () => {
      if (!alive || !last || !healthy) return;
      if (!enrichment) { deliver(last); return; }
      const usage = new Map((enrichment.entries || []).map(e => [e.sessionId, e]));
      const visible = new Set(last.entries.map(e => e.sessionId));
      deliver({ ...last, quota: enrichment.quota, detailsError: enrichment.detailsError,
        webArtifacts: (enrichment.webArtifacts || []).filter(a => visible.has(a.sessionId)),
        entries: last.entries.map(e => { const old = usage.get(e.sessionId); return old?.webThreadId === e.webThreadId && old.usage ? { ...e, usage: old.usage } : e; }) });
    };
    // Execution state must not wait for history, token totals or quota I/O.
    // Late detail responses enrich the newest state; never replay their status.
    const enrich = () => {
      if (!alive || !last || !includeDetails) return;
      if (enriching) { detailsPending = true; return; }
      const delay = detailsAt + 5000 - Date.now();
      if (delay > 0) {
        if (!detailsTimer) { detailsTimer = setTimeout(() => { detailsTimer = null; enrich(); }, delay); detailsTimer.unref?.(); }
        return;
      }
      detailsAt = Date.now();
      enriching = true; const entries = last.entries;
      void bindings().then(config => details(entries, config)).then(value => {
        enrichment = value; if (!busy) publish();
      }).catch(() => { enrichment = { detailsError: '附加信息暂时无法读取' }; if (!busy) publish(); }).finally(() => {
        enriching = false; if (detailsPending && alive) { detailsPending = false; enrich(); }
      });
    };
    const refresh = id => {
      if (!alive) return;
      if (busy) {
        pending = true;
        if (!id) fullPending = true;
        else for (const value of Array.isArray(id) ? id : [id]) changedIds.add(value);
        return;
      }
      busy = true;
      // Every tenth minute refresh rereads all records as a safety net for any
      // change whose metadata version did not move.
      const deep = !id && Date.now() - deepAt >= 600000;
      if (deep) deepAt = Date.now();
      void snapshot(ids, id, deep ? null : last, groupIds, false).then(data => { if (alive) { last = data; healthy = true; publish(); enrich(); } }).catch(error => { if (alive) { healthy = false; lastDigest = ''; fail(error); } }).finally(() => {
        busy = false; if (pending && alive) {
          const next = fullPending ? '' : [...changedIds];
          pending = false; fullPending = false; changedIds.clear(); refresh(next);
        }
      });
    };
    const off = onSessionInvalidation(hint => {
      if (hint.type === 'session_invalidated') refresh(hint.sessionId || '');
      else if (hint.type === 'sessions_invalidated') refresh('');
    });
    let watcher;
    if (!deps.bindings) { const config = await bindings(); watcher = watch(dirname(config.file), (_, name) => { if ((config.watchFiles || [config.file]).some(file => String(name) === file.split('/').at(-1))) refresh(''); }); watcher.on('error', fail); }
    const refreshTimer=setInterval(()=>refresh(''),60000);refreshTimer.unref?.();
    refresh('');
    return () => { alive = false; clearInterval(refreshTimer); clearTimeout(detailsTimer); off(); watcher?.close(); };
  }
  async function review(webThreadId, resultAt) {
    const data = await snapshot([webThreadId], '', null, [], false);
    const entry = data.entries.find(e => e.webThreadId === webThreadId);
    if (!entry || !resultAt || !Number.isFinite(Date.parse(resultAt)) || Date.parse(resultAt) > Date.parse(entry.resultAt || '')) throw Object.assign(Error('已读结果与话题不匹配。'), { status: 409 });
    return (deps.acknowledge || acknowledgeSessionResult)(entry.sessionId, resultAt);
  }
  return { snapshot, subscribe, review };
}
export const feishuTopicSource = createFeishuTopicSource();
