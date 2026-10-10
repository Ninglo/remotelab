import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { readRecord, writeDurableJson, serialQueue } from '../lib/durable-records.mjs';
import { findIdentity, loadAuthDocument } from '../lib/auth-config.mjs';
import { loadPersonMessageReplies, changePersonMessageReplies } from './person-message-replies.mjs';
import { completeRuntimeProfile, reasoningForRuntimeProfile } from '../lib/runtime-profile.mjs';
import { isQuickSession } from '../lib/quick-session-profile.mjs';
import { sessionRuntimeRevision } from '../lib/session-runtime-revision.mjs';

const file = join(CONFIG_DIR, 'feishu-web-settings-connections.json');
const queue = serialQueue();
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
export function feishuOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && /^(?:[a-z0-9-]+\.)?feishu\.cn$/.test(url.hostname) && url.origin === value) return value;
  } catch {}
  fail('请从飞书 Web 的设置入口连接。');
}
function account(value) {
  if (typeof value !== 'string' || !/^\d{10,30}$/.test(value)) fail('无法核对当前飞书浏览器账号。');
  return value;
}
async function personActor(actor) {
  const identity = findIdentity(await loadAuthDocument({ persistMigration: false }), actor?.identityId);
  if (!actor?.personId || actor.authKind === 'service' || identity?.person.id !== actor.personId) fail('请使用本人的登录账号连接消息设置。', 403);
  return { personId: actor.personId, identityId: actor.identityId, personName: identity.person.name };
}
async function mutateConnections(fn) {
  return queue(async () => {
    const data = await readRecord(file) || { version: 1, connections: [] };
    if (data.version !== 1 || !Array.isArray(data.connections)) fail('消息设置连接记录无法读取。', 500);
    data.connections = data.connections.filter(entry => entry.expiresAt > Date.now());
    const result = await fn(data);
    await writeDurableJson(file, data);
    return result;
  });
}
export async function connectFeishuWebSettings(input, actor, capability = 'settings') {
  if (!['settings', 'workspace'].includes(capability)) fail('Unknown connection capability');
  if (!input || Object.keys(input).some(key => !['origin', 'nativeAccount', 'confirm'].includes(key)) || input.confirm !== true) fail('请明确连接你自己的消息设置。');
  const verified = await personActor(actor), origin = feishuOrigin(input.origin), nativeAccount = account(input.nativeAccount);
  const token = `${capability === 'workspace' ? 'fwspace' : 'fwset'}_${randomBytes(32).toString('base64url')}`, expiresAt = Date.now() + 30 * 86400000;
  await mutateConnections(data => {
    data.connections = data.connections.filter(entry => !(entry.personId === verified.personId && entry.origin === origin && entry.nativeAccount === nativeAccount && (entry.capability || 'settings') === capability));
    data.connections.push({ ...verified, origin, nativeAccount, capability, tokenHash: hash(token), expiresAt });
    if (data.connections.filter(entry => entry.personId === verified.personId).length > 20) fail('个人消息设置连接过多，请先断开旧连接。');
  });
  return { token, expiresAt, person: { id: verified.personId, name: verified.personName }, origin, nativeAccount };
}
export async function authorizeFeishuWebSettings(token, origin, nativeAccount, capability = 'settings') {
  const pattern = capability === 'workspace' ? /^fwspace_[a-zA-Z0-9_-]{43}$/ : /^fwset_[a-zA-Z0-9_-]{43}$/;
  if (typeof token !== 'string' || !pattern.test(token)) fail('请先连接本人的账号。', 401);
  feishuOrigin(origin); account(nativeAccount);
  const data = await readRecord(file);
  const connection = data?.connections?.find(entry => entry.tokenHash === hash(token) && entry.origin === origin && entry.nativeAccount === nativeAccount && entry.expiresAt > Date.now());
  if (!connection || (connection.capability || 'settings') !== capability) fail('连接已失效，请重新连接。', 401);
  return { ...await personActor(connection), authKind: 'feishu-web-settings', tokenHash: connection.tokenHash };
}
export async function disconnectFeishuWebSettings(actor) {
  await mutateConnections(data => { data.connections = data.connections.filter(entry => entry.tokenHash !== actor.tokenHash); });
}
export const loadFeishuWebReplies = loadPersonMessageReplies;
export const saveFeishuWebReplies = changePersonMessageReplies;

export const runtimeFingerprint = sessionRuntimeRevision;
export async function readFeishuWebRuntime(sessionId, { getSession, getModels }) {
  if (typeof sessionId !== 'string' || !/^[a-f0-9]{32}$/.test(sessionId)) fail('当前对话尚未关联 Bot 工作。', 404);
  const session = await getSession(sessionId);
  if (!session || session.archived || session.conversation?.connector !== 'feishu') fail('当前对话尚未关联可设置的飞书工作。', 404);
  const catalog = await getModels(session.tool);
  const profile = completeRuntimeProfile(session.feishuRuntimeSelection || session, catalog);
  return { sessionId, name: session.name || '当前对话', ...profile, thinking: session.thinking === true,
    revision: runtimeFingerprint(session), locked: isQuickSession(session),
    models: (catalog.models || []).map(({ id, label, reasoning }) => ({ id, label, reasoning })), reasoning: catalog.reasoning };
}
export async function saveFeishuWebRuntime(input, deps) {
  if (!input || Object.keys(input).some(key => !['sessionId', 'expectedRevision', 'model', 'effort', 'confirm'].includes(key)) || input.confirm !== true) fail('请明确保存当前对话模型。');
  const current = await readFeishuWebRuntime(input.sessionId, deps);
  if (current.locked) fail('Quick 对话的模型在创建时固定，请在 Standard 对话中设置。');
  if (current.revision !== input.expectedRevision) fail('当前对话模型已更新，请重新载入后再保存。', 409);
  if (!current.models.some(model => model.id === input.model)) fail('这个模型目前不可选。');
  const reasoning = reasoningForRuntimeProfile(current, input.model);
  if (reasoning.kind === 'enum' ? !reasoning.levels?.includes(input.effort) : input.effort !== '') fail('请选择这个模型支持的思考程度。');
  await deps.updateRuntime(input.sessionId, { model: input.model, effort: input.effort }, { expectedRuntimeRevision: input.expectedRevision });
  return readFeishuWebRuntime(input.sessionId, deps);
}
