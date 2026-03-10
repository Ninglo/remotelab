/**
 * Shared global WebSocket broadcast.
 * Decoupled from ws.mjs to avoid circular imports.
 */
let wss = null;

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

export function broadcastOwners(msg) {
  if (!wss) return;
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    if (client._authSession?.role !== 'owner') continue;
    try { client.send(data); } catch {}
  }
}
