// A normal-launcher guard, not an OS sandbox or a privileged credential broker.
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

export const PERSONAL_GUARD_FILE = 'remotelab-personal-guard.json';
const deny = code => { const error = new Error(`Personal Feishu access denied: ${code}`); error.code = code; throw error; };
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

function parseArgs(args) {
  const positionals = [], flags = new Map();
  const booleans = new Set(['--dry-run', '--json', '--verify', '--help', '-h']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) { positionals.push(arg); continue; }
    const equal = arg.indexOf('='), name = equal < 0 ? arg : arg.slice(0, equal);
    if (flags.has(name)) deny('duplicate_option');
    let value;
    if (booleans.has(name)) {
      if (equal >= 0) deny('invalid_boolean');
      value = true;
    } else {
      value = equal >= 0 ? arg.slice(equal + 1) : args[++i];
      if (!nonempty(value) || value.startsWith('--')) deny('invalid_option');
    }
    flags.set(name, value);
  }
  return { positionals, flags };
}

function optionsOnly(flags, allowed) {
  for (const name of flags.keys()) if (!allowed.includes(name)) deny('unsupported_option');
}

export function validatePersonalGuard(policy) {
  if (policy?.version !== 1 || typeof policy.enabled !== 'boolean' || policy.mode !== 'manual'
      || ![policy.personId, policy.profile, policy.appId, policy.owner?.route, policy.owner?.tenant, policy.owner?.openId,
        policy.disclosure, policy.sourceRequestId].every(nonempty)
      || !Array.isArray(policy.conversations) || !policy.conversations.length
      || policy.conversations.some(c => !nonempty(c.chatId) || !nonempty(c.peerOpenId))) deny('invalid_policy');
  for (const field of ['notBefore', 'expiresAt']) {
    if (policy[field] !== undefined && (!nonempty(policy[field]) || !Number.isFinite(Date.parse(policy[field])))) deny('invalid_window');
  }
  if (policy.notBefore && policy.expiresAt && Date.parse(policy.notBefore) >= Date.parse(policy.expiresAt)) deny('invalid_window');
  return policy;
}

function verifyActor(policy, request, context) {
  const opts = request?.options || {}, source = opts.sourceContext || {};
  if (!request || request.sessionId !== context.sessionId || request.requestId !== context.requestId
      || request.result || request.releasedAt
      || (request.nativeDispatchRunId || request.runId) !== context.runId
      || opts.internalOperation || opts.deliveryOnly || opts.scheduleId || opts.triggerId
      || opts.feishuConnectorAuthenticated !== true || opts.viewPersonId !== policy.personId
      || source.connector !== 'feishu' || source.sourceRouteId !== policy.owner.route
      || source.tenantKey !== policy.owner.tenant || source.sender?.senderType !== 'user'
      || source.sender?.openId !== policy.owner.openId) deny('owner_request_required');
}

export function evaluatePersonalLarkCommand({ policy, args, request, latestRequest, context, config, now = Date.now() }) {
  validatePersonalGuard(policy);
  if (!policy.enabled) deny('disabled');
  if (![context?.sessionId, context?.requestId, context?.runId].every(nonempty)) deny('active_request_required');
  verifyActor(policy, request, context);
  // A later person steering the same run must not inherit the root author's grant.
  if (!latestRequest) deny('latest_request_unavailable');
  verifyActor(policy, latestRequest, { ...context, requestId: latestRequest.requestId });
  const { positionals: p, flags: f } = parseArgs(args);
  if (f.get('--profile') !== policy.profile) deny('explicit_profile_required');
  const app = config?.apps?.find(item => item.name === policy.profile);
  if (!app || app.appId !== policy.appId || app.users?.length !== 1 || app.users[0].userOpenId !== policy.owner.openId) deny('account_mismatch');
  const common = ['--profile', '--json'];
  if (p.join(' ') === 'auth status') {
    optionsOnly(f, [...common, '--verify']);
    return { args, action: 'auth-status', ownerPersonId: policy.personId };
  }
  if (p.join(' ') === 'auth logout') {
    optionsOnly(f, common);
    return { args, action: 'auth-logout', ownerPersonId: policy.personId };
  }
  if (policy.notBefore && now < Date.parse(policy.notBefore) || policy.expiresAt && now >= Date.parse(policy.expiresAt)) deny('outside_window');
  if (f.get('--as') !== 'user') deny('explicit_user_identity_required');
  if (p.join(' ') === 'im +messages-send') {
    optionsOnly(f, [...common, '--as', '--user-id', '--chat-id', '--text', '--idempotency-key', '--dry-run']);
    const peer = f.get('--user-id'), chat = f.get('--chat-id'), body = f.get('--text');
    if (Boolean(peer) === Boolean(chat) || !policy.conversations.some(c => peer ? c.peerOpenId === peer : c.chatId === chat)) deny('conversation_not_allowed');
    if (!nonempty(body) || !nonempty(f.get('--idempotency-key'))) deny('text_and_idempotency_required');
    const stamped = body.endsWith(policy.disclosure) ? body : `${body}\n\n${policy.disclosure}`;
    const output = ['--profile', policy.profile, 'im', '+messages-send', '--as', 'user',
      ...(peer ? ['--user-id', peer] : ['--chat-id', chat]), '--text', stamped, '--idempotency-key', f.get('--idempotency-key')];
    if (f.has('--dry-run')) output.push('--dry-run');
    if (f.has('--json')) output.push('--json');
    return { args: output, action: 'send-text', ownerPersonId: policy.personId, target: peer || chat };
  }
  if (p.join(' ') === 'api GET /open-apis/im/v1/messages') {
    optionsOnly(f, [...common, '--as', '--params', '--dry-run']);
    let params;
    try { params = JSON.parse(f.get('--params')); } catch { deny('inline_query_required'); }
    if (!params || typeof params !== 'object' || Array.isArray(params)) deny('inline_query_required');
    if (Object.keys(params).some(k => !['container_id_type', 'container_id', 'start_time', 'end_time', 'sort_type', 'page_size', 'page_token'].includes(k))) deny('unsupported_query');
    if (params.container_id_type !== 'chat' || !policy.conversations.some(c => c.chatId === params.container_id)) deny('conversation_not_allowed');
    for (const key of ['start_time', 'end_time']) if (params[key] !== undefined && !/^\d+$/.test(String(params[key]))) deny('invalid_time_query');
    if (params.page_size !== undefined && (!Number.isInteger(params.page_size) || params.page_size < 1 || params.page_size > 50)) deny('invalid_page_size');
    return { args, action: 'read-conversation', ownerPersonId: policy.personId, target: params.container_id };
  }
  deny('operation_not_allowed');
}

export async function guardPersonalLarkCli(args, { env = process.env, configDir, instanceRoot, loadRequest, loadLatestRequest, now } = {}) {
  const root = instanceRoot || env.REMOTELAB_INSTANCE_ROOT || homedir();
  const selected = configDir || env.LARKSUITE_CLI_CONFIG_DIR || join(homedir(), '.lark-cli');
  let directory;
  try { directory = await realpath(selected); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    directory = resolve(selected);
  }
  let personalRoot;
  try { personalRoot = await realpath(join(root, 'config', 'lark-cli-personal')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; personalRoot = resolve(root, 'config', 'lark-cli-personal'); }
  const personal = directory === personalRoot || directory.startsWith(personalRoot + sep);
  let policy;
  try { policy = JSON.parse(await readFile(join(directory, PERSONAL_GUARD_FILE), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' && !personal) return { args, guarded: false };
    deny('policy_unavailable');
  }
  validatePersonalGuard(policy);
  const context = { sessionId: env.REMOTELAB_SESSION_ID, requestId: env.REMOTELAB_REQUEST_ID, runId: env.REMOTELAB_RUN_ID };
  if (![context.sessionId, context.requestId, context.runId].every(nonempty)) deny('active_request_required');
  if (!loadRequest) {
    const { requests } = await import('../chat/requests.mjs');
    loadRequest = (sessionId, requestId) => requests.byRequest(sessionId, requestId);
  }
  if (!loadLatestRequest) {
    const { findLatestUserMessage } = await import('../chat/history.mjs');
    loadLatestRequest = async sessionId => {
      const event = await findLatestUserMessage(sessionId);
      return event?.requestId ? loadRequest(sessionId, event.requestId) : null;
    };
  }
  const [request, latestRequest, configText] = await Promise.all([
    loadRequest(context.sessionId, context.requestId), loadLatestRequest(context.sessionId), readFile(join(directory, 'config.json'), 'utf8'),
  ]);
  return { ...evaluatePersonalLarkCommand({ policy, args, request, latestRequest, context, config: JSON.parse(configText), now }), guarded: true };
}
