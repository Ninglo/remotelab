#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import WebSocket from 'ws';
import * as Lark from '@larksuiteoapi/node-sdk';
import { writeJsonAtomic } from '../chat/fs-utils.mjs';
import { createRemoteLabHttpClient } from '../lib/remotelab-http-client.mjs';
import {
  collectFeishuWorkboardCycles,
  isFeishuWorkboardPilotSession,
  publishFeishuWorkboardCycle,
} from '../connectors/feishu/workboard-pilot.mjs';

const statePath = process.argv[2];
if (!statePath || process.argv.length !== 3) {
  console.error('Usage: node scripts/feishu-workboard-pilot.mjs <private-state.json>');
  process.exit(2);
}

const pilot = JSON.parse(await readFile(statePath, 'utf8'));
if (!pilot.sessionId || !pilot.chatId || !pilot.senderOpenId || !pilot.sourceRouteId
    || !pilot.botConfigPath || !Number.isInteger(pilot.startedAfterSeq)
    || !Number.isFinite(Date.parse(pilot.expiresAt))) {
  throw new Error('Incomplete Feishu workboard pilot state');
}
if (Date.now() >= Date.parse(pilot.expiresAt)) process.exit(0);
pilot.cards ||= [];

const botConfig = JSON.parse(await readFile(pilot.botConfigPath, 'utf8'));
if (botConfig.botId !== pilot.sourceRouteId || !botConfig.appId || !botConfig.appSecret) {
  throw new Error('Feishu Bot config does not match this pilot route');
}
const app = new Lark.Client({
  appId: botConfig.appId,
  appSecret: botConfig.appSecret,
  domain: botConfig.region === 'lark-global' ? Lark.Domain.Lark : Lark.Domain.Feishu,
  loggerLevel: Lark.LoggerLevel.warn,
});
const remote = createRemoteLabHttpClient({ baseUrl: botConfig.chatBaseUrl });
const requestJson = async path => {
  const result = await remote.request(path);
  if (!result.response.ok) throw new Error(result.json?.error || `RemoteLab GET failed: ${result.response.status}`);
  return result.json;
};
const persist = () => writeJsonAtomic(statePath, pilot, { mode: 0o600 });

async function verifyMessage(messageId, content) {
  const readback = await app.im.v1.message.get({ path: { message_id: messageId } });
  const item = readback?.data?.items?.find(entry => entry.message_id === messageId);
  if (readback?.code !== 0 || !item || item.body?.content !== content) {
    throw new Error(`Feishu workboard readback did not match message ${messageId}`);
  }
}

let stopped = false;
let syncing = false;
let pending = false;
let socket = null;
let reconnectTimer = null;
let reconnectMs = 250;

async function sync() {
  if (stopped || Date.now() >= Date.parse(pilot.expiresAt)) { stop(); return; }
  if (syncing) { pending = true; return; }
  syncing = true;
  try {
    do {
      pending = false;
      const session = (await requestJson(`/api/sessions/${encodeURIComponent(pilot.sessionId)}`)).session;
      if (!isFeishuWorkboardPilotSession(session, pilot)) {
        stop();
        throw new Error('Pilot Session is disabled or no longer matches the intended private chat');
      }
      const events = (await requestJson(`/api/sessions/${encodeURIComponent(pilot.sessionId)}/events?filter=all`)).events;
      for (const cycle of collectFeishuWorkboardCycles(events, pilot)) {
        if (stopped || Date.now() >= Date.parse(pilot.expiresAt)) { stop(); break; }
        const result = await publishFeishuWorkboardCycle(cycle, { pilot, app, persist, verifyMessage });
        if (result) console.log(`[feishu-workboard] ${result.action} anchor=${result.anchorSeq} revision=${result.revision}`);
      }
    } while (pending && !stopped);
  } finally {
    syncing = false;
  }
}

function stop() {
  stopped = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  socket?.close();
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
const expiryTimer = setTimeout(stop, Math.max(1, Date.parse(pilot.expiresAt) - Date.now()));
expiryTimer.unref();

function connect(cookie) {
  if (stopped) return;
  socket = new WebSocket(remote.baseUrl.replace(/^http/, 'ws') + '/ws', {
    headers: { Cookie: cookie },
  });
  socket.on('open', () => {
    reconnectMs = 250;
    void sync().catch(error => console.error(`[feishu-workboard] sync: ${error.message}`));
  });
  socket.on('message', data => {
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (message.type === 'session_invalidated' && message.sessionId === pilot.sessionId) {
      void sync().catch(error => console.error(`[feishu-workboard] sync: ${error.message}`));
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
      await requestJson(`/api/sessions/${encodeURIComponent(pilot.sessionId)}`);
      connect(await remote.ensureAuthCookie());
    } catch (error) {
      console.error(`[feishu-workboard] reconnect: ${error.message}`);
      scheduleReconnect();
    }
  }, reconnectMs);
  reconnectMs = Math.min(5000, reconnectMs * 2);
}

await sync(); // Read state before waiting for notifications.
connect(await remote.ensureAuthCookie());
