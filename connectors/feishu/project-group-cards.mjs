import { readFile } from 'node:fs/promises';
import { AUTH_FILE } from '../../lib/config.mjs';
import { GROUP_ROUTING_PILOT_FILE } from '../../lib/group-routing-pilot.mjs';
import WebSocket from 'ws';
import { watch } from 'node:fs';
import { dirname, basename } from 'node:path';
import { loadProjectMemoryRuntime, PROJECT_MEMORY_RUNTIME_FILE } from '../../chat/project-memory-runtime.mjs';
import { buildSessionNavigationHref } from '../../lib/session-navigation.mjs';
import { effectiveFeishuGroup } from './group-settings.mjs';
import { KNOWLEDGE_ROOT, knowledgeConfig } from '../../chat/knowledge-pilot.mjs';
import { join } from 'node:path';

export async function groupProject(runtime, chatId) {
  if (!runtime.config.projectCards) return null;
  const { config } = await loadProjectMemoryRuntime();
  const group = config.groups.find(g => g.sourceRouteId === runtime.config.sourceRouteId && g.chatId === chatId);
  if (!group || group.projectIds.length !== 1) return null;
  const project = config.projects.find(p => p.id === group.projectIds[0]);
  return { ...project, group, groups: config.groups.filter(g => g.sourceRouteId === runtime.config.sourceRouteId
    && g.projectIds.length === 1 && g.projectIds[0] === project.id) };
}

export function projectTopicRows(sessions, chatId, route) {
  return [...sessions.values()].filter(s => !s.archived && s.conversation?.connector === 'feishu'
    && s.conversation.sourceRouteId === route && s.conversation.target?.chatId === chatId
    && (s.conversation.target.threadId || s.conversation.target.conversationKind === 'thread'))
    .map(s => {
      const running = s.activity?.run?.state === 'running' || Boolean(s.activeRunId);
      const waiting = s.activity?.run?.waiting || s.workflowState === 'waiting_user';
      const queued = (s.activity?.queue?.count || 0) > 0;
      const newerInput = (Number(s.lastUserMessageAt) || Date.parse(s.lastUserMessageAt) || 0)
        > (Number(s.lastAssistantMessageAt) || Date.parse(s.lastAssistantMessageAt) || 0);
      const state = waiting ? '等待输入' : running ? '进行中' : queued ? '排队中'
        : s.workflowState === 'done' && !newerInput ? '已完成' : '未在运行';
      const t = s.conversation.target;
      return { id: s.id, title: s.name || '未命名话题', state,
        url: `https://applink.feishu.cn/client/thread/open?open_chat_id=${encodeURIComponent(chatId)}&open_thread_id=${encodeURIComponent(t.threadId || t.rootId || t.messageId)}`,
        sessionUrl: buildSessionNavigationHref(s.id, { requireAbsolute: true }),
        updatedAt: s.updatedAt || '', priority: waiting ? 0 : running ? 1 : 2 };
    }).sort((a,b) => a.priority - b.priority || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

// Uses native Session invalidations and a bounded debounce. No polling task or
// model decides state; the card is a view over the original Sessions.
export async function startProjectGroupCards(runtime, { request, ensureAuthCookie, onboard, participation }) {
  if (!runtime.config.projectCards) return { stop() {} };
  const sessions = new Map();
  const reads = new Map(), pendingReads = new Set();
  runtime.projectCardSessions = sessions;
  const pending = new Set();
  const active = new Set();
  const track = promise => { active.add(promise); promise.finally(() => active.delete(promise)).catch(() => {}); return promise; };
  let stopped = false, socket, timer, reconnect, draining = false, retryMs = 250;
  const observers = new Map();
  const knowledgeGroups = new Map();
  const warn = e => console.warn(`[feishu-project-cards] ${e.message}`);
  async function json(path, options) {
    const r = await request(path, options);
    if (!r.response?.ok) throw Error(r.json?.error || `Project cards HTTP ${r.response?.status}`);
    return r.json;
  }
  const summaryFor = group => ({ chatId: group.chatId, chatName: group.chatName || '',
    tenantKey: group.tenantKey || [...sessions.values()].find(s => s.conversation?.target?.chatId === group.chatId)?.conversation.target.tenantKey || '',
    chatType: 'group', conversationKind: 'main', sourceKind: 'project_card' });
  async function routingGroups() {
    let config;
    try { config = JSON.parse(await readFile(GROUP_ROUTING_PILOT_FILE, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    // Keep refreshing registered cards when the pilot is switched off, so
    // previously published names are removed from non-project groups too.
    return config.version === 2
      ? (config.groups || []).filter(g => g.sourceRouteId === runtime.config.sourceRouteId) : [];
  }
  async function refresh(chatId) {
    const project = await groupProject(runtime, chatId);
    if (stopped) return;
    const pilot = (await routingGroups()).find(g => g.chatId === chatId);
    const { config } = await loadProjectMemoryRuntime();
    const readingGroup = config.readingPolicy && config.groups.find(g => g.chatId === chatId && g.sourceRouteId === runtime.config.sourceRouteId);
    const knowledgeGroup = knowledgeGroups.get(chatId);
    if (!project && !pilot && !readingGroup && !knowledgeGroup) return;
    const summary = summaryFor(project?.group || pilot || readingGroup || knowledgeGroup);
    if (!summary.tenantKey) throw Error(`Missing verified tenant for ${chatId}`);
    const record = await participation().state(summary);
    await participation().publish(record, { existingOnly: true, background: true });
  }
  async function drain() {
    if (draining || stopped) return;
    draining = true;
    try {
      while (pending.size && !stopped) {
        const id = pending.values().next().value; pending.delete(id);
        try { await refresh(id); } catch(e) { warn(e); }
      }
    } finally { draining = false; }
  }
  function enqueue(chatId) {
    if (!chatId || stopped) return;
    pending.add(chatId);
    schedule();
  }
  function schedule() {
    if (stopped || timer) return;
    // Apply the existing card debounce before HTTP reads as well as writes.
    timer = setTimeout(() => {
      timer = null;
      for (const sessionId of pendingReads) {
        if (reads.has(sessionId)) continue;
        pendingReads.delete(sessionId);
        const task = json(`/api/sessions/${encodeURIComponent(sessionId)}?view=summary`).then(({session}) => {
          if (stopped) return;
          const old = sessions.get(sessionId);
          if (session) sessions.set(sessionId, session); else sessions.delete(sessionId);
          for (const chatId of [old?.conversation?.target?.chatId, session?.conversation?.target?.chatId]) {
            if (chatId) pending.add(chatId);
          }
          void track(drain());
        }).catch(warn).finally(() => {
          reads.delete(sessionId);
          if (pendingReads.has(sessionId)) schedule();
        });
        reads.set(sessionId, task); track(task);
      }
      void track(drain());
    }, 500);
  }
  function observe(file) {
    if (stopped || observers.has(file)) return;
    try {
      const w = watch(dirname(file), { persistent: false }, (_, name) => {
        if (name && String(name) !== basename(file)) return;
        void reloadSources().catch(warn);
      });
      w.on('error', warn); observers.set(file, w);
    } catch(e) { warn(e); }
  }
  async function reloadSources() {
    if (stopped) return;
    const knowledge = await knowledgeConfig();
    for (const group of knowledge?.groups || []) {
      if (group.sourceRouteId === runtime.config.sourceRouteId) knowledgeGroups.set(group.chatId, group);
    }
    // Retain addresses already displayed so disabling/removing a scope also
    // clears that experiment from its existing card.
    for (const group of knowledgeGroups.values()) enqueue(group.chatId);
    for (const group of await routingGroups()) enqueue(group.chatId);
    const { config } = await loadProjectMemoryRuntime();
    for (const group of config.groups.filter(g => g.sourceRouteId === runtime.config.sourceRouteId && (config.readingPolicy || g.projectIds.length === 1))) {
      const project = config.projects.find(p => p.id === group.projectIds[0]);
      if (project?.briefPath) observe(project.briefPath);
      enqueue(group.chatId);
    }
  }
  async function discover() {
    const { sessions: values = [] } = await json('/api/sessions');
    sessions.clear(); for (const s of values) sessions.set(s.id, s);
    const { config } = await loadProjectMemoryRuntime();
    for (const group of config.groups.filter(g => g.sourceRouteId === runtime.config.sourceRouteId && g.projectIds.length === 1)) {
      if (stopped) return;
      const summary = summaryFor(group);
      if (!summary.tenantKey) { warn(Error(`Missing verified tenant for ${group.chatId}`)); continue; }
      // Card authorization is separate from response policy and never unpauses a project.
      if (effectiveFeishuGroup(runtime.config, group.chatId).participationStatusCard === false) continue;
      try { await onboard(summary, { projectCard: true }); } catch(e) { warn(e); }
    }
    await reloadSources();
  }
  async function connect() {
    if (stopped) return;
    try {
      const cookie = await ensureAuthCookie();
      if (stopped) return;
      socket = new WebSocket(runtime.config.chatBaseUrl.replace(/^http/, 'ws') + '/ws', { headers: { Cookie: cookie } });
      socket.on('open', () => { retryMs = 250; runtime.projectCardsConnected = true; void track(discover()).catch(warn); });
      socket.on('message', raw => {
        let m; try { m = JSON.parse(raw); } catch { return; }
        if (m.type !== 'session_invalidated' || !m.sessionId) return;
        pendingReads.add(m.sessionId); schedule();
      });
      socket.on('error', warn);
      socket.on('close', () => {
        runtime.projectCardsConnected = false;
        void reloadSources().catch(warn);
        scheduleReconnect();
      });
    } catch(e) { warn(e); scheduleReconnect(); }
  }
  function scheduleReconnect() {
    if (stopped || reconnect) return;
    reconnect = setTimeout(() => { reconnect = null; void connect(); }, retryMs);
    retryMs = Math.min(5000, retryMs * 2);
  }
  observe(PROJECT_MEMORY_RUNTIME_FILE);
  observe(AUTH_FILE);
  observe(GROUP_ROUTING_PILOT_FILE);
  observe(join(KNOWLEDGE_ROOT, 'config.json'));
  await connect();
  return { async stop() { stopped = true; clearTimeout(timer); clearTimeout(reconnect); socket?.close();
    for (const w of observers.values()) w.close();
    await Promise.allSettled([...active]);
  } };
}
