/**
 * Shared global WebSocket broadcast.
 * Decoupled from ws.mjs to avoid circular imports.
 */
import { hintAutomationActivity } from '../lib/automation-events.mjs';

let wss = null;
const invalidationListeners = new Set();

// Local projections share the same change hints as clients, even before a WS
// server exists. List readers can update one record without revisiting cold ones.
export function onSessionInvalidation(listener) {
  invalidationListeners.add(listener);
  return () => invalidationListeners.delete(listener);
}

export function setWss(instance) {
  wss = instance;
}

export function getClientsMatching(predicate = () => true) {
  if (!wss) return [];
  const matches = [];
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    if (!predicate(client)) continue;
    matches.push(client);
  }
  return matches;
}

export function broadcastMatching(msg, predicate = () => true) {
  if (!wss) return;
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    if (!predicate(client)) continue;
    try { client.send(data); } catch {}
  }
}

// Every client rereads a Session on each hint, so a running Session's bursts
// multiply across browser tabs, connectors and display sync. Send the first
// hint at once, then at most one trailing hint per window per Session. Hints
// carrying extra payload are delivered unchanged; local listeners stay immediate.
const sessionHintWindowMs = Math.max(0, Number(process.env.REMOTELAB_SESSION_HINT_WINDOW_MS ?? 500) || 0);
const sessionHintWindows = new Map();

function plainSessionHint(msg) {
  return msg.type === 'session_invalidated' && typeof msg.sessionId === 'string' && msg.sessionId
    && Object.keys(msg).length === 2;
}

function closeSessionHintWindow(sessionId) {
  const window = sessionHintWindows.get(sessionId);
  if (!window) return;
  if (!window.pending) { sessionHintWindows.delete(sessionId); return; }
  window.pending = false;
  broadcastMatching({ type: 'session_invalidated', sessionId });
  window.timer = setTimeout(() => closeSessionHintWindow(sessionId), sessionHintWindowMs);
  window.timer.unref?.();
}

function broadcastSessionHint(msg) {
  if (!sessionHintWindowMs || !plainSessionHint(msg)) { broadcastMatching(msg); return; }
  const window = sessionHintWindows.get(msg.sessionId);
  if (window) { window.pending = true; return; }
  broadcastMatching(msg);
  const timer = setTimeout(() => closeSessionHintWindow(msg.sessionId), sessionHintWindowMs);
  timer.unref?.();
  sessionHintWindows.set(msg.sessionId, { timer, pending: false });
}

export function broadcastAll(msg) {
  for (const listener of invalidationListeners) {
    try { listener(msg); }
    catch (error) { console.error('[ws] local projection hint failed:', error.message); }
  }
  if (msg.type === 'session_invalidated' || msg.type === 'sessions_invalidated') hintAutomationActivity(msg.sessionId || '');
  broadcastSessionHint(msg);
}
