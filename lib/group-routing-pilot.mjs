import { readFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { CONFIG_DIR } from './config.mjs';

export const GROUP_ROUTING_PILOT_FILE = join(CONFIG_DIR, 'group-routing-pilot.json');
export async function routingPilotScope(conversation, path = GROUP_ROUTING_PILOT_FILE) {
  if (conversation?.connector !== 'feishu') return null;
  let config;
  try { config = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (config.version !== 1 || config.enabled !== true) return null;
  const target = conversation.target || conversation;
  return (Array.isArray(config.groups) ? config.groups : []).find(group => group.sourceRouteId === conversation.sourceRouteId
    && group.chatId === target.chatId && group.tenantKey === target.tenantKey
    && ['sourceRouteId', 'chatId', 'tenantKey'].every(key => typeof group[key] === 'string' && group[key])
    && isAbsolute(group.folder || '')) || null;
}

// Activation fences old deliveries/replays. A missing transport timestamp does
// not authorize moving pre-existing work when the operator set a fence.
export function isPilotInputSinceActivation(scope, inputTime) {
  if (!scope) return false;
  if (!scope.activatedAt) return true;
  const raw = Number(inputTime);
  const time = Number.isFinite(raw) && raw > 0 ? (raw < 1e12 ? raw * 1000 : raw) : Date.parse(inputTime);
  return Number.isFinite(time) && time >= Date.parse(scope.activatedAt);
}
