import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { createSerialTaskQueue, writeJsonAtomic } from '../../chat/fs-utils.mjs';
import { createProgressCardRefresh } from './progress-card-refresh.mjs';
import { createWorkboardEventReader } from './workboard-event-reader.mjs';
import { createWorkboardQuotaGate } from './workboard-quota-gate.mjs';
import { feishuResponseError } from './delivery-errors.mjs';
import {
  collectFeishuWorkboardCycles,
  collectFeishuGroupWorkboardCycles,
  collectFeishuInstanceWorkboardCycles,
  isFeishuInstanceWorkboardSession,
  expandFeishuWorkboardUpdates,
  isFeishuWorkboardGroupSession,
  isFeishuWorkboardPilotSession,
  publishFeishuWorkboardCycle,
} from './workboard-pilot.mjs';

// Connector-owned card publication. No process, signal handlers or provider client
// of its own. The caller owns credentials, startup, shutdown and health reporting.
export async function createFeishuWorkboardSync({ statePath, pilot, app, remote, onStatus = async () => {} }) {
  const instanceScope = pilot.scope === 'instance';
  pilot.sessions ||= {};
  pilot.cards ||= [];
  pilot.groupSessions ||= {};
  let migrating = pilot.protocolVersion !== 2;
  const expired = () => Boolean(pilot.expiresAt) && Date.now() >= Date.parse(pilot.expiresAt);
  const requestJson = async path => {
    const result = await remote.request(path);
    if (!result.response.ok) throw new Error(result.json?.error || `RemoteLab GET failed: ${result.response.status}`);
    return result.json;
  };
  const eventReader = createWorkboardEventReader(requestJson, { checkpointDir: `${statePath}.projection` });
  const projectionHeads = new Map();
  const forceProjection = new Set();
  async function cardEvents(sessionId, session) {
    // Bump the renderer version when existing acknowledged cards need a new
    // rendering without new history. Session display/authorization changes
    // also invalidate an acknowledgement, without including activity clocks.
    const renderKey = createHash('sha256').update(JSON.stringify({ renderer: 1,
      policy: Object.fromEntries(Object.entries(session || {}).filter(([key]) => /^(feishu|workboard|conversation)/.test(key))),
      scope: pilot.scope, sourceRouteId: pilot.sourceRouteId, senderOpenId: pilot.senderOpenId,
      legacySenderOpenId: pilot.legacySenderOpenId, progressStartedAt: pilot.progressStartedAt,
      groupProgressRestoredAt: pilot.groupProgressRestoredAt,
    })).digest('hex');
    const { events, afterSeq, hasMore } = await eventReader.read(sessionId, {
      skipAcknowledged: true, renderKey, force: forceProjection.has(sessionId),
    });
    if (hasMore) { enqueue(sessionId); return null; }
    if (events) projectionHeads.set(sessionId, { afterSeq, renderKey });
    return events;
  }
  async function acknowledgeProjection(sessionId) {
    const head = projectionHeads.get(sessionId);
    if (head) {
      await eventReader.acknowledge(sessionId, head.afterSeq, head.renderKey);
      projectionHeads.delete(sessionId);
      forceProjection.delete(sessionId);
    }
  }
  const persistQueue = createSerialTaskQueue();
  const persist = () => persistQueue(() => writeJsonAtomic(statePath, pilot, { mode: 0o600 }));
  let health = { state: 'starting', failures: {} };
  const report = async (state, error = '') => {
    health = { ...health, state, error, pid: process.pid, updatedAt: new Date().toISOString() };
    await onStatus(health).catch(error => console.error(`[feishu-workboard] health persistence: ${error.message}`));
  };
  if (instanceScope && !Number.isFinite(pilot.progressStartedAt)) {
    // Durable route-wide upgrade fence, including Sessions discovered later.
    pilot.progressStartedAt = Date.now();
    await persist();
  }
  if (process.env.REMOTELAB_FEISHU_GROUP_MESSAGE_BASELINE === '2026-10-07'
      && !Number.isFinite(pilot.groupProgressRestoredAt)) {
    // A durable route-wide floor includes group Sessions discovered later.
    // Existing card IDs and acknowledgements remain intact.
    pilot.groupProgressRestoredAt = Date.now();
    await persist();
  }

  async function verifyMessage(messageId, { updated } = {}, chatId = pilot.chatId) {
    const readback = await app.im.v1.message.get({ path: { message_id: messageId } });
    if (readback?.code !== 0) throw feishuResponseError(readback, 'Feishu workboard readback failed');
    const item = readback?.data?.items?.find(entry => entry.message_id === messageId);
    // IM get exposes a compatibility preview for v2 cards, not the card JSON.
    // The patch response is the content-write receipt; readback checks its
    // identity, destination, type and updated state.
    if (readback?.code !== 0 || !item || item.chat_id !== chatId
        || item.msg_type !== 'interactive' || (updated && item.updated !== true)) {
      throw new Error(`Feishu workboard readback did not match message ${messageId}`);
    }
  }

  let stopped = false;
  let syncing = false;
  let drainPromise = Promise.resolve();
  let initializePromise = Promise.resolve();
  let expiryTimer = null;
  const pending = new Set();
  const urgent = new Set();
  const ignored = new Set();
  const retries = new Map();
  const quotaGate = createWorkboardQuotaGate({ onBlocked: async failure => {
    for (const timer of retries.values()) clearTimeout(timer);
    retries.clear();
    pilot.quotaBlocked = failure;
    await persist();
    await report('quota_blocked', failure.message);
    console.error('[feishu-workboard] monthly API quota exhausted; card publication paused; restore quota then restart this connector');
  } });
  const disclosures = createProgressCardRefresh(pilot);
  let socket = null;
  let reconnectTimer = null;
  let reconnectMs = 250;

  async function publishCycle(cycle, cardPilot, chatId) {
    cycle = disclosures.apply(cycle);
    const result = await publishFeishuWorkboardCycle(cycle, { pilot: cardPilot, app, persist,
      verifyMessage: (messageId, options) => verifyMessage(messageId, options, chatId) });
    if (result && pilot.quotaBlocked) { delete pilot.quotaBlocked; await persist(); }
    disclosures.remember(cycle);
    if (result) console.log(`[feishu-workboard] ${result.action} session=${cycle.sessionId} anchor=${result.anchorSeq} revision=${result.revision}`);
  }

  async function syncDisclosure(change) {
    // On cold start, read this Session now rather than putting the click behind
    // the route's whole bootstrap backlog. The normal admission checks remain.
    if (!change.cycle) { forceProjection.add(change.sessionId); await syncOne(change.sessionId); return; }
    const stored = instanceScope ? pilot.sessions[change.sessionId]
      : change.sessionId === pilot.sessionId ? pilot : pilot.groupSessions[change.sessionId];
    const start = Date.now();
    await publishCycle(change.cycle, { ...pilot, ...stored, sessionId: change.sessionId }, stored.chatId);
    console.log(`[feishu-workboard] disclosure session=${change.sessionId} anchor=${change.anchorSeq} queueMs=${start - change.receivedAt} updateMs=${Date.now() - start}`);
  }

  async function syncPrivate() {
    const session = (await requestJson(`/api/sessions/${encodeURIComponent(pilot.sessionId)}`)).session;
    if (!isFeishuWorkboardPilotSession(session, pilot)) return;
    const events = await cardEvents(pilot.sessionId, session);
    if (!events) return;
    if (!Number.isInteger(pilot.protocolAfterSeq)) {
      pilot.protocolAfterSeq = migrating ? Math.max(0, ...events.map(event => event.seq || 0)) : 0;
      await persist();
    }
    for (const cycle of expandFeishuWorkboardUpdates(collectFeishuWorkboardCycles(events, pilot, session), events)) {
      if (stopped || expired()) { halt(); break; }
      await publishCycle(cycle, pilot, pilot.chatId);
    }
    if (!stopped) await acknowledgeProjection(pilot.sessionId);
  }

  async function syncGroup(sessionId) {
    if (!pilot.groupEnabled || ignored.has(sessionId)) return;
    const response = await remote.request(`/api/sessions/${encodeURIComponent(sessionId)}?view=summary`);
    if (response.response.status === 404) { ignored.add(sessionId); return; }
    if (!response.response.ok) throw new Error(`Group Session read failed: ${response.response.status}`);
    const session = response.json?.session;
    const target = session?.conversation?.target;
    if (session?.conversation?.connector !== 'feishu'
        || session.conversation.sourceRouteId !== pilot.sourceRouteId
        || target?.chatType !== 'group') {
      ignored.add(sessionId);
      return;
    }
    if (!isFeishuWorkboardGroupSession(session, pilot)) return;
    const stored = pilot.groupSessions[sessionId] ||= { chatId: target.chatId, cards: [] };
    if (stored.chatId !== target.chatId) throw new Error(`Group Session destination changed: ${sessionId}`);
    const groupPilot = { ...pilot, sessionId, chatId: target.chatId,
      startedAfterSeq: 0, cards: stored.cards };
    const events = await cardEvents(sessionId, session);
    if (!events) return;
    if (!Number.isInteger(stored.protocolAfterSeq)) {
      // Upgrade fence: preserve old cards without replaying historical revisions.
      stored.protocolAfterSeq = migrating ? Math.max(0, ...events.map(event => event.seq || 0)) : 0;
      await persist();
    }
    groupPilot.protocolAfterSeq = stored.protocolAfterSeq;
    for (const cycle of expandFeishuWorkboardUpdates(collectFeishuGroupWorkboardCycles(events, groupPilot, session), events)) {
      if (stopped || expired()) { halt(); break; }
      await publishCycle(cycle, groupPilot, target.chatId);
    }
    if (!stopped) await acknowledgeProjection(sessionId);
  }

  async function syncInstance(sessionId) {
    const response = await remote.request(`/api/sessions/${encodeURIComponent(sessionId)}?view=summary`);
    if (response.response.status === 404) return;
    if (!response.response.ok) throw new Error(`Workboard Session read failed: ${response.response.status}`);
    const session = response.json?.session;
    if (!isFeishuInstanceWorkboardSession(session, pilot)) return;
    const target = session.conversation.target;
    const stored = pilot.sessions[sessionId] ||= { chatId: target.chatId, cards: [], protocolAfterSeq: 0 };
    if (stored.chatId !== target.chatId) throw new Error(`Workboard Session destination changed: ${sessionId}`);
    const sessionPilot = { ...pilot, ...stored, sessionId };
    const events = await cardEvents(sessionId, session);
    if (!events) return;
    for (const cycle of expandFeishuWorkboardUpdates(collectFeishuInstanceWorkboardCycles(events, sessionPilot, session))) {
      if (stopped || expired()) { halt(); break; }
      await publishCycle(cycle, sessionPilot, target.chatId);
    }
    if (!stopped) await acknowledgeProjection(sessionId);
  }

  async function discoverGroupSessions() {
    if (!instanceScope && !pilot.groupEnabled) return [];
    const list = await requestJson('/api/sessions?sourceId=feishu');
    const sessions = Array.isArray(list.sessions) ? list.sessions : [];
    const live = sessions.filter(session => session.activity?.run?.state === 'running'
      && session.workboardPilot === true && session.conversation?.sourceRouteId === pilot.sourceRouteId);
    return [...new Set([
      ...live.map(session => session.id),
      ...Object.keys(instanceScope ? pilot.sessions : pilot.groupSessions),
      ...(Array.isArray(list.sessions) ? list.sessions : [])
        .filter(session => session?.workboardPilot === true
          && session?.conversation?.connector === 'feishu'
          && session.conversation.sourceRouteId === pilot.sourceRouteId
          && (instanceScope ? isFeishuInstanceWorkboardSession(session, pilot)
            : session.conversation.target?.chatType === 'group'))
        .map(session => session.id),
    ])];
  }

  async function syncOne(sessionId) {
    if (instanceScope) return syncInstance(sessionId);
    if (sessionId === pilot.sessionId) return syncPrivate();
    return syncGroup(sessionId);
  }

  function drain() {
    if (!syncing) drainPromise = drainQueue().catch(async error => {
      console.error(`[feishu-workboard] queue: ${error.message}`);
      await report('degraded', error.message).catch(() => {});
    });
    return drainPromise;
  }

  async function drainQueue() {
    if (syncing || quotaGate.blocked) return;
    syncing = true;
    try {
      while ((disclosures.size || urgent.size || pending.size) && !stopped && !quotaGate.blocked) {
        // Human clicks take precedence over queued automatic refreshes. Keep
        // the same single writer and sequence fences for both update paths.
        const change = disclosures.take();
        const sessionId = change?.sessionId || urgent.values().next().value || pending.values().next().value;
        if (!change) { pending.delete(sessionId); urgent.delete(sessionId); }
        try {
          if (change) await syncDisclosure(change);
          else await syncOne(sessionId);
          if (retries.has(sessionId)) clearTimeout(retries.get(sessionId));
          retries.delete(sessionId);
          if (health.failures[sessionId]) {
            delete health.failures[sessionId];
            await report(Object.keys(health.failures).length ? 'degraded' : 'ready');
          }
        } catch (error) {
          console.error(`[feishu-workboard] sync ${sessionId}: ${error.message}`);
          health.failures[sessionId] = error.message;
          if (await quotaGate.observe(error)) continue;
          await report('degraded', error.message);
          // Patches are idempotent. An uncertain creation needs inspection rather
          // than another send; the publisher durably fences that outcome.
          if (!/outcome is unknown/.test(error.message) && !retries.has(sessionId) && !stopped) {
            retries.set(sessionId, setTimeout(() => { retries.delete(sessionId); enqueue(sessionId); }, 2000));
          }
        }
      }
    } finally { syncing = false; }
  }

  function enqueue(sessionId, live = false) {
    if (!sessionId || stopped) return;
    if (live) urgent.add(sessionId);
    else pending.add(sessionId);
    void drain();
  }

  function halt() {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    for (const timer of retries.values()) clearTimeout(timer);
    if (expiryTimer) clearTimeout(expiryTimer);
    socket?.terminate();
  }
  if (pilot.expiresAt) {
    expiryTimer = setTimeout(halt, Math.max(1, Date.parse(pilot.expiresAt) - Date.now()));
    expiryTimer.unref();
  }

  function connect(cookie) {
    if (stopped) return;
    if (socket) { socket.removeAllListeners(); socket.on('error', () => {}); socket.terminate(); }
    socket = new WebSocket(remote.baseUrl.replace(/^http/, 'ws') + '/ws', {
      headers: { Cookie: cookie },
    });
    socket.on('open', () => {
      reconnectMs = 250;
      void discoverGroupSessions().then(ids => {
        if (!instanceScope) enqueue(pilot.sessionId);
        for (const id of ids) enqueue(id);
      }).catch(error => console.error(`[feishu-workboard] discovery: ${error.message}`));
    });
    socket.on('message', data => {
      let message;
      try { message = JSON.parse(data); } catch { return; }
      if (message.type === 'session_invalidated' && (instanceScope || message.sessionId === pilot.sessionId || pilot.groupEnabled)) {
        if (disclosures.accept(message)) void drain();
        else enqueue(message.sessionId, true);
      }
    });
    socket.on('error', error => console.error(`[feishu-workboard] socket: ${error.message}`));
    socket.on('close', () => {
      if (stopped) return;
      void report('reconnecting').catch(() => {});
      scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      try {
        // HTTP refreshes an expired cookie before the next WebSocket handshake.
        await (initializePromise = initialize());
      } catch (error) {
        console.error(`[feishu-workboard] reconnect: ${error.message}`);
        await report('reconnecting', error.message).catch(() => {});
        scheduleReconnect();
      }
    }, reconnectMs);
    reconnectMs = Math.min(5000, reconnectMs * 2);
  }

  async function initialize() {
    if (stopped) return;
    if (instanceScope) {
      for (const id of await discoverGroupSessions()) pending.add(id);
      // Subscribe before walking all historical cards. A human click must not
      // wait for every other Session to finish its startup refresh.
      connect(await remote.ensureAuthCookie());
      // A fenced uncertain send in one Session must not stop other cards or
      // bring down the route worker. The serial drain isolates those failures.
      await drain();
    } else {
      await syncPrivate();
      for (const id of await discoverGroupSessions()) await syncOne(id);
    }
    pilot.protocolVersion = 2;
    migrating = false;
    if (stopped) return;
    pilot.runtime = { owner: 'connector', pid: process.pid, readyAt: new Date().toISOString() };
    await persist();
    if (!instanceScope) connect(await remote.ensureAuthCookie());
    await report(quotaGate.blocked ? 'quota_blocked' : Object.keys(health.failures).length ? 'degraded' : 'ready', health.error);
    console.log(`[feishu-workboard] ready route=${pilot.sourceRouteId} scope=${instanceScope ? 'instance' : 'person'}`);
  }

  await report('starting');
  initializePromise = initialize().catch(async error => {
    console.error(`[feishu-workboard] startup: ${error.message}`);
    await report('reconnecting', error.message).catch(() => {});
    scheduleReconnect();
  });
  return {
    getStatus: () => structuredClone(health),
    async stop() {
      halt();
      await initializePromise.catch(() => {});
      await drainPromise;
      await persistQueue(async () => {});
      await report('stopped');
    },
  };
}
