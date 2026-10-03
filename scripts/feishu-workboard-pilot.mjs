#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import WebSocket from 'ws';
import * as Lark from '@larksuiteoapi/node-sdk';
import { createSerialTaskQueue, writeJsonAtomic } from '../chat/fs-utils.mjs';
import { createRemoteLabHttpClient } from '../lib/remotelab-http-client.mjs';
import {
  collectFeishuWorkboardCycles,
  collectFeishuGroupWorkboardCycles,
  collectFeishuInstanceWorkboardCycles,
  isFeishuInstanceWorkboardSession,
  expandFeishuWorkboardUpdates,
  isFeishuWorkboardGroupSession,
  isFeishuWorkboardPilotSession,
  publishFeishuWorkboardCycle,
} from '../connectors/feishu/workboard-pilot.mjs';

const disableOnly = process.argv[2] === '--disable';
const statePath = process.argv[disableOnly ? 3 : 2];
if (!statePath || process.argv.length !== (disableOnly ? 4 : 3)) {
  console.error('Usage: node scripts/feishu-workboard-pilot.mjs [--disable] <private-state.json>');
  process.exit(2);
}

const pilot = JSON.parse(await readFile(statePath, 'utf8'));
const instanceScope = pilot.scope === 'instance';
if (!pilot.sourceRouteId || !pilot.botConfigPath
    || (!instanceScope && (!pilot.sessionId || !pilot.chatId || !pilot.senderOpenId
      || !Number.isInteger(pilot.startedAfterSeq)))
    || (pilot.expiresAt && !Number.isFinite(Date.parse(pilot.expiresAt)))) {
  throw new Error('Incomplete Feishu workboard state');
}
pilot.sessions ||= {};
pilot.cards ||= [];
pilot.groupSessions ||= {};
let migrating = pilot.protocolVersion !== 2;
if (pilot.groupEnabled === true && !pilot.personId) {
  throw new Error('Group workboard pilot requires an opted-in Person');
}

const botConfig = JSON.parse(await readFile(pilot.botConfigPath, 'utf8'));
if ((botConfig.botId || 'default') !== pilot.sourceRouteId || !botConfig.appId || !botConfig.appSecret) {
  throw new Error('Feishu Bot config does not match this pilot route');
}
const remote = createRemoteLabHttpClient({ baseUrl: botConfig.chatBaseUrl });
if (disableOnly) {
  if (instanceScope) throw new Error('Disable instance activation and stop its route services; no Session stop hook is used');
  const path = `/api/sessions/${encodeURIComponent(pilot.sessionId)}`;
  const current = await remote.request(path);
  if (!current.response.ok) throw new Error(`Unable to read pilot Session (${current.response.status})`);
  if (isFeishuWorkboardPilotSession(current.json?.session, pilot)) {
    const result = await remote.request(path, { method: 'PATCH', body: { workboardPilot: false } });
    if (!result.response.ok || result.json?.session?.workboardPilot !== false) {
      throw new Error(`Unable to disable Feishu workboard pilot (${result.response.status})`);
    }
    console.log('[feishu-workboard] pilot disabled');
  }
  process.exit(0);
}
const expired = () => Boolean(pilot.expiresAt) && Date.now() >= Date.parse(pilot.expiresAt);
if (expired()) process.exit(0);
const app = new Lark.Client({
  appId: botConfig.appId,
  appSecret: botConfig.appSecret,
  domain: botConfig.region === 'lark-global' ? Lark.Domain.Lark : Lark.Domain.Feishu,
  loggerLevel: Lark.LoggerLevel.warn,
});
const requestJson = async path => {
  const result = await remote.request(path);
  if (!result.response.ok) throw new Error(result.json?.error || `RemoteLab GET failed: ${result.response.status}`);
  return result.json;
};
const persistQueue = createSerialTaskQueue();
const persist = () => persistQueue(() => writeJsonAtomic(statePath, pilot, { mode: 0o600 }));

async function verifyMessage(messageId, { updated } = {}, chatId = pilot.chatId) {
  const readback = await app.im.v1.message.get({ path: { message_id: messageId } });
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
const pending = new Set();
const ignored = new Set();
const retries = new Map();
let socket = null;
let reconnectTimer = null;
let reconnectMs = 250;

async function syncPrivate() {
  const session = (await requestJson(`/api/sessions/${encodeURIComponent(pilot.sessionId)}`)).session;
  if (!isFeishuWorkboardPilotSession(session, pilot)) return;
  const events = (await requestJson(`/api/sessions/${encodeURIComponent(pilot.sessionId)}/events?filter=all`)).events;
  if (!Number.isInteger(pilot.protocolAfterSeq)) {
    pilot.protocolAfterSeq = migrating ? Math.max(0, ...events.map(event => event.seq || 0)) : 0;
    await persist();
  }
  for (const cycle of expandFeishuWorkboardUpdates(collectFeishuWorkboardCycles(events, pilot), events)) {
    if (stopped || expired()) { stop(); break; }
    const result = await publishFeishuWorkboardCycle(cycle, { pilot, app, persist, verifyMessage });
    if (result) console.log(`[feishu-workboard] ${result.action} session=${pilot.sessionId} anchor=${result.anchorSeq} revision=${result.revision}`);
  }
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
  const events = (await requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/events?filter=all`)).events;
  if (!Number.isInteger(stored.protocolAfterSeq)) {
    // Upgrade fence: preserve old cards without replaying historical revisions.
    stored.protocolAfterSeq = migrating ? Math.max(0, ...events.map(event => event.seq || 0)) : 0;
    await persist();
  }
  groupPilot.protocolAfterSeq = stored.protocolAfterSeq;
  for (const cycle of expandFeishuWorkboardUpdates(collectFeishuGroupWorkboardCycles(events, groupPilot, session), events)) {
    if (stopped || expired()) { stop(); break; }
    const result = await publishFeishuWorkboardCycle(cycle, { pilot: groupPilot, app, persist,
      verifyMessage: (messageId, options) => verifyMessage(messageId, options, target.chatId) });
    if (result) console.log(`[feishu-workboard] ${result.action} session=${sessionId} anchor=${result.anchorSeq} revision=${result.revision}`);
  }
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
  const events = (await requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/events?filter=all`)).events;
  for (const cycle of expandFeishuWorkboardUpdates(collectFeishuInstanceWorkboardCycles(events, sessionPilot, session))) {
    if (stopped || expired()) { stop(); break; }
    const result = await publishFeishuWorkboardCycle(cycle, { pilot: sessionPilot, app, persist,
      verifyMessage: (messageId, options) => verifyMessage(messageId, options, target.chatId) });
    if (result) console.log(`[feishu-workboard] ${result.action} session=${sessionId} anchor=${result.anchorSeq} revision=${result.revision}`);
  }
}

async function discoverGroupSessions() {
  if (!instanceScope && !pilot.groupEnabled) return [];
  const list = await requestJson('/api/sessions?sourceId=feishu');
  return [...new Set([
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

async function drain() {
  if (syncing) return;
  syncing = true;
  try {
    while (pending.size && !stopped) {
      const sessionId = pending.values().next().value;
      pending.delete(sessionId);
      try {
        await syncOne(sessionId);
        if (retries.has(sessionId)) clearTimeout(retries.get(sessionId));
        retries.delete(sessionId);
      } catch (error) {
        console.error(`[feishu-workboard] sync ${sessionId}: ${error.message}`);
        // Patches are idempotent. An uncertain creation needs inspection rather
        // than another send; the publisher durably fences that outcome.
        if (!/outcome is unknown/.test(error.message) && !retries.has(sessionId)) {
          retries.set(sessionId, setTimeout(() => { retries.delete(sessionId); enqueue(sessionId); }, 2000));
        }
      }
    }
  } finally { syncing = false; }
}

function enqueue(sessionId) {
  if (!sessionId || stopped) return;
  pending.add(sessionId);
  void drain();
}

function stop() {
  stopped = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  for (const timer of retries.values()) clearTimeout(timer);
  socket?.close();
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
if (pilot.expiresAt) {
  const expiryTimer = setTimeout(stop, Math.max(1, Date.parse(pilot.expiresAt) - Date.now()));
  expiryTimer.unref();
}

function connect(cookie) {
  if (stopped) return;
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
      enqueue(message.sessionId);
    }
  });
  socket.on('error', error => console.error(`[feishu-workboard] socket: ${error.message}`));
  socket.on('close', () => {
    if (stopped) return;
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (stopped) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      // HTTP refreshes an expired cookie before the next WebSocket handshake.
      await initialize();
    } catch (error) {
      console.error(`[feishu-workboard] reconnect: ${error.message}`);
      scheduleReconnect();
    }
  }, reconnectMs);
  reconnectMs = Math.min(5000, reconnectMs * 2);
}

async function initialize() {
  if (instanceScope) {
    for (const id of await discoverGroupSessions()) pending.add(id);
    // A fenced uncertain send in one Session must not stop other cards or
    // bring down the route worker. The serial drain isolates those failures.
    await drain();
  } else {
    await syncPrivate();
    for (const id of await discoverGroupSessions()) await syncOne(id);
  }
  pilot.protocolVersion = 2;
  migrating = false;
  pilot.runtime = { pid: process.pid, readyAt: new Date().toISOString() };
  await persist();
  connect(await remote.ensureAuthCookie());
  console.log(`[feishu-workboard] ready route=${pilot.sourceRouteId} scope=${instanceScope ? 'instance' : 'person'}`);
}

try { await initialize(); } // Read state before waiting for notifications.
catch (error) {
  // The controller can start later at boot. Stay alive and reconnect rather
  // than exhausting systemd's restart limit before it is ready.
  console.error(`[feishu-workboard] startup: ${error.message}`);
  scheduleReconnect();
}
