import { readFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { CONFIG_DIR } from './config.mjs';

export const GROUP_ROUTING_PILOT_FILE = join(CONFIG_DIR, 'group-routing-pilot.json');
export function hasPilotInputReplyContract(record) {
  return record?.options?.routingPilotMainline === true && record.options.routingPilotMainlineProtocol === 2;
}
export async function routingPilotScope(conversation, path = GROUP_ROUTING_PILOT_FILE, personId = '') {
  if (conversation?.connector !== 'feishu') return null;
  let config;
  try { config = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (![1, 2].includes(config.version) || config.enabled !== true) return null;
  if (config.version === 2 && (!personId || !config.personIds?.includes(personId))) return null;
  const target = conversation.target || conversation;
  const group = (Array.isArray(config.groups) ? config.groups : []).find(group => group.sourceRouteId === conversation.sourceRouteId
    && group.chatId === target.chatId && group.tenantKey === target.tenantKey
    && ['sourceRouteId', 'chatId', 'tenantKey'].every(key => typeof group[key] === 'string' && group[key])
    && isAbsolute(group.folder || ''));
  return group ? { ...group, version: config.version, trialId: config.trialId || '',
    crossGroupSync: config.version === 2 && config.crossGroupSync === true } : null;
}

export async function routingSyncTargetAllowed(origin, target, personId) {
  if (origin?.connector !== 'feishu' || target?.connector !== 'feishu'
      || origin.sourceRouteId !== target.sourceRouteId || origin.target?.tenantKey !== target.target?.tenantKey) return false;
  const source = await routingPilotScope(origin, undefined, personId);
  if (!source) return false;
  if (origin.target?.chatId === target.target?.chatId) return true;
  const destination = await routingPilotScope(target, undefined, personId);
  return !!(source.crossGroupSync && source.trialId && destination?.trialId === source.trialId);
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
