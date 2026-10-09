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

export function broadcastAll(msg) {
  for (const listener of invalidationListeners) {
    try { listener(msg); }
    catch (error) { console.error('[ws] local projection hint failed:', error.message); }
  }
  if (msg.type === 'session_invalidated' || msg.type === 'sessions_invalidated') hintAutomationActivity(msg.sessionId || '');
  broadcastMatching(msg);
}
