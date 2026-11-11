// Optional admission guard. This is a text/identity boundary, not a filesystem sandbox.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { readRecord, writeDurableJson, serialQueue } from '../lib/durable-records.mjs';
import { isLimitedInterviewQuestion, limitedInterviewReply } from './limited-interview.mjs';
import { confidentialActorAllowed } from '../lib/hr-access-authorization.mjs';
import { explicitAccessIntents } from './access-intent.mjs';

const queue = serialQueue();
const hash = value => createHash('sha256').update(value).digest('hex');
export const ACCESS_REFUSAL = '这项内容属于内部 HR 资料，当前未核验到对应访问权限，无法提供。';

export function normalizeAccessText(text) {
  let result = String(text || '').slice(0, 65536).normalize('NFKC').replace(/\p{Cf}/gu, '');
  try { result = decodeURIComponent(result); } catch { /* Keep malformed input as text. */ }
  result = result.replace(/\\u([\da-f]{4})/gi, (_, digits) => String.fromCharCode(parseInt(digits, 16)));
  const encoded = result.match(/[A-Za-z0-9+/]{16,}={0,2}/g) || [];
  for (const token of encoded) {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    if (!decoded.includes('\ufffd')) result += '\n' + decoded;
  }
  // Include a compact view for spaced-out Chinese names and policy words.
  return result + '\n' + result.replace(/\s+/g, '');
}

function rules(config) {
  if (![1, 2].includes(config.version) || !config.policyId || !Array.isArray(config.allowPairs)
      || !Array.isArray(config.rules) || !config.rules.length) throw new Error('Invalid request access guard configuration');
  return config.rules.map(rule => {
    if (!['protected', 'indirect', 'bypass'].includes(rule.category)) throw new Error('Invalid guard category');
    if (config.version === 2 && (!rule.id || !Array.isArray(rule.all) || !rule.all.length)) throw new Error('Invalid operation rule');
    return { ...rule, patterns: rule.all.map(pattern => new RegExp(pattern, 'iu')) };
  });
}

function operationGranted(config, input, category) {
  const options = input.options || {}, source = options.sourceContext || {};
  return (config.operationGrants || []).some(grant => grant.sessionId === input.sessionId
    && grant.requestId === options.requestId && grant.textSha256 === hash(String(input.text || '').trim())
    && grant.operations?.includes(category) && grant.approvalRef
    && (options.feishuConnectorAuthenticated === true && source.connector === 'feishu'
      ? source.sender?.senderType === 'user' && grant.actor?.route === source.sourceRouteId
        && grant.actor?.tenant === source.tenantKey && grant.actor?.openId === source.sender.openId
        && grant.actor?.chatId === source.chatId
      : grant.personId && grant.identityId && grant.personId === options.viewPersonId
        && grant.identityId === options.initiatedByIdentityId));
}

async function contentOperationDecision(input, config, compiled, stateRoot, now) {
  const options = input.options || {}, source = options.sourceContext || {};
  const actor = options.feishuConnectorAuthenticated === true && source.connector === 'feishu'
    ? ['feishu', source.sourceRouteId, source.tenantKey, source.sender?.openId || 'unverified']
    : [options.viewPersonId || '', options.initiatedByIdentityId || ''];
  const statePath = join(stateRoot, 'scopes', hash(JSON.stringify([input.sessionId, actor])) + '.json');
  const previous = await readRecord(statePath);
  const active = previous?.version === 2 && previous.policyId === config.policyId
    && now >= previous.at && now - previous.at < (config.contextSeconds || 86400) * 1000 ? previous : null;
  // normalizeAccessText's compact duplicate is useful to v1 regexes, but v2
  // whole-utterance continuations must inspect each decoded view separately.
  const normalized = normalizeAccessText(input.text);
  const intents = [...explicitAccessIntents(String(input.text || '').normalize('NFKC'), compiled, active),
    ...explicitAccessIntents(normalized.split('\n').filter(Boolean).slice(0, -1).join('\n'), compiled, active)];
  const allowed = confidentialActorAllowed(config, options);
  const privateChannel = !(options.feishuConnectorAuthenticated === true && source.connector === 'feishu')
    || ['p2p', 'private'].includes(source.chatType);
  const businessActor = options.feishuConnectorAuthenticated === true && source.connector === 'feishu'
    && source.sender?.senderType === 'user' && (config.interview?.actors || []).some(entry =>
      entry.route === source.sourceRouteId && entry.tenant === source.tenantKey && entry.openId === source.sender.openId);
  const business = Boolean(config.interview && isLimitedInterviewQuestion(String(input.text || ''))
    && (!allowed || businessActor) && !options.restrictedRecruiting && !options.internalOperation && !options.deliveryOnly);
  const automation = (config.automations || []).some(task => task.id === (options.scheduleId || options.triggerId)
    && task.identityId === options.initiatedByIdentityId && task.textSha256 === hash(String(input.text || '').trim()));
  const matched = !automation && intents.find(intent => !(intent.category === 'bypass'
    ? operationGranted(config, input, 'bypass') : allowed && privateChannel));
  const denied = Boolean(matched);
  // Every unrelated turn clears the prior target. No conversation-history
  // substring search and no same-person 24-hour taint inheritance.
  await writeDurableJson(statePath, { version: 2, policyId: config.policyId, at: now,
    targetId: denied ? matched.targetId : null, targetCategory: denied ? matched.category : null });
  if (!denied) return business ? { blocked: true, business: true, policyId: config.policyId, reply: '' } : null;
  const reason = matched.category === 'bypass' ? 'operation_not_granted'
    : allowed && !privateChannel ? 'private_channel_required' : 'restricted_request';
  return persistDenial(input, { blocked: true, ...(business ? { business: true } : {}), category: matched.category,
    policyId: config.policyId, policyVersion: 2, targetId: matched.targetId, reason,
    reply: reason === 'operation_not_granted' ? '该权限或防护变更尚无对应操作授权，未执行。'
      : reason === 'private_channel_required' ? '该资料尚未核验当前群的接收权限，请在已核验的私聊中查询。' : ACCESS_REFUSAL,
  }, stateRoot, now);
}

async function persistDenial(input, decision, stateRoot, now) {
  const options = input.options || {}, source = options.sourceContext || {};
  if (!input.sessionId || !options.requestId) throw new Error('Access guard requires a stable request identity');
  const key = hash(JSON.stringify([input.sessionId, options.requestId])).slice(0, 24);
  // Pending decisions are consumed by the independent observer. No input text,
  // attachments, conversation history or credentials enter this audit outbox.
  await writeDurableJson(join(stateRoot, 'denials', 'pending', key + '.json'), {
    key, sessionId: input.sessionId, requestId: options.requestId,
    guardDecisionAt: new Date(now).toISOString(), options: {
      viewPersonId: options.viewPersonId, initiatedByIdentityId: options.initiatedByIdentityId,
      usageSurface: options.usageSurface, feishuConnectorAuthenticated: options.feishuConnectorAuthenticated,
      accessGuard: decision,
      sourceContext: { connector: source.connector, sourceRouteId: source.sourceRouteId, tenantKey: source.tenantKey,
        messageId: source.messageId, sender: source.sender && { openId: source.sender.openId, senderType: source.sender.senderType } },
    },
  });
  return decision;
}

export async function evaluateRequestAccess(input, {
  configPath = process.env.REMOTELAB_REQUEST_ACCESS_GUARD,
  stateRoot = join(CONFIG_DIR, 'request-access-guard'), now = Date.now(),
} = {}) {
  if (!configPath) return null;
  let interviewConfig;
  const decision = await queue(async () => {
    let config, compiled;
    try { config = JSON.parse(await readFile(configPath, 'utf8')); compiled = rules(config); }
    catch { return persistDenial(input, { blocked: true, category: 'protected', policyId: 'guard-unavailable', reason: 'policy_unavailable',
      reply: '资料访问检查暂时不可用，本条请求未交给模型。请稍后重试。' }, stateRoot, now); }
    if (config.version === 2) {
      if (String(input.text || '').length > 65536) return persistDenial(input, { blocked: true,
        category: 'protected', policyId: config.policyId, reason: 'inspection_limit', reply: '消息过长，请拆分后重新发送。' }, stateRoot, now);
      const result = await contentOperationDecision(input, config, compiled, stateRoot, now);
      if (result?.business) interviewConfig = config.interview;
      return result;
    }
    const options = input.options || {};
    const pair = [options.viewPersonId || '', options.initiatedByIdentityId || ''];
    const source = options.sourceContext || {};
    const allowed = config.allowPairs.some(entry => entry[0] && entry[1] && entry[0] === pair[0] && entry[1] === pair[1]);
    const connectorAllowed = options.feishuConnectorAuthenticated === true && source.connector === 'feishu'
      && source.sender?.senderType === 'user' && (config.allowFeishu || []).some(entry =>
        entry.route === source.sourceRouteId && entry.tenant === source.tenantKey && entry.openId === source.sender?.openId);
    const maintenance = (config.maintenance || []).some(entry => entry.sessionId === input.sessionId
      && entry.personId === pair[0] && entry.identityId === pair[1]);
    const privilegedBypass = (allowed || connectorAllowed) && !maintenance && compiled.find(rule =>
      rule.category === 'bypass' && rule.patterns.every(pattern => pattern.test(normalizeAccessText(input.text))));
    const privateOnly = (allowed || connectorAllowed) && options.feishuConnectorAuthenticated === true
      && source.connector === 'feishu' && !['p2p', 'private'].includes(source.chatType)
      && compiled.find(rule => !rule.continuation && rule.patterns.every(pattern => pattern.test(normalizeAccessText(input.text))));
    const businessActor = options.feishuConnectorAuthenticated === true && source.connector === 'feishu'
      && source.sender?.senderType === 'user' && (config.interview?.actors || []).some(actor =>
        actor.route === source.sourceRouteId && actor.tenant === source.tenantKey && actor.openId === source.sender.openId);
    const business = config.interview && isLimitedInterviewQuestion(String(input.text || ''))
      && (!(allowed || connectorAllowed) || businessActor) && !options.restrictedRecruiting && !maintenance
      && !options.internalOperation && !options.deliveryOnly;
    if ((allowed || connectorAllowed) && !privilegedBypass && !privateOnly && !business) return null;
    // Existing internal operations retain their scopes; scheduled exceptions are exact.
    if ((config.automations || []).some(task => task.id === (options.scheduleId || options.triggerId)
        && task.identityId === options.initiatedByIdentityId && task.textSha256 === hash(String(input.text || '').trim()))) return null;
    if (options.deliveryOnly || options.internalOperation) return null;
    if (String(input.text || '').length > 65536) return persistDenial(input, {
      blocked: true, category: 'protected', policyId: config.policyId, reason: 'inspection_limit',
      reply: '消息过长，本条未交给模型。请拆分后重新发送。',
    }, stateRoot, now);
    const actor = options.feishuConnectorAuthenticated === true && source.connector === 'feishu'
      ? ['feishu', source.sourceRouteId, source.tenantKey, source.sender?.openId || 'unverified'] : pair;
    const scope = hash(JSON.stringify([input.sessionId, actor]));
    const statePath = join(stateRoot, 'scopes', scope + '.json');
    const previous = await readRecord(statePath);
    const continuation = Boolean(previous && now - previous.at >= 0 && now - previous.at < (config.contextSeconds || 86400) * 1000);
    const text = normalizeAccessText(input.text);
    let matched = privilegedBypass || privateOnly || compiled.find(rule => (!rule.continuation || continuation) && rule.patterns.every(pattern => pattern.test(text)));
    // Connector history is useful only when the same authenticated sender wrote
    // the earlier input. Bot replies, quotes and other people's text confer no authority.
    if (!matched && options.feishuConnectorAuthenticated && source.sender?.openId) {
      const ownHistory = (source.conversationContext?.messages || []).slice(-20).filter(item =>
        item.senderType === 'user' && item.authorRef?.subjectId === source.sender.openId
        && item.authorRef?.realm === source.sourceRouteId && Number.isFinite(Date.parse(item.time))
        && now - Date.parse(item.time) >= 0 && now - Date.parse(item.time) < (config.contextSeconds || 86400) * 1000);
      const hadTarget = ownHistory.some(item => compiled.some(rule => !rule.continuation
        && rule.patterns.every(pattern => pattern.test(normalizeAccessText(item.text)))));
      if (hadTarget) matched = compiled.find(rule => rule.continuation && rule.patterns.every(pattern => pattern.test(text)));
    }
    if ((allowed || connectorAllowed) && !privilegedBypass && !privateOnly) matched = null;
    if (business) {
      interviewConfig = config.interview;
      if (!matched) return { blocked: true, business: true, policyId: config.policyId, reply: '' };
      await writeDurableJson(statePath, { version: 1, at: now, policyId: config.policyId });
      return persistDenial(input, { blocked: true, business: true, category: matched.category,
        policyId: config.policyId, reason: 'restricted_part', reply: ACCESS_REFUSAL }, stateRoot, now);
    }
    if (!matched) return null;
    await writeDurableJson(statePath, { version: 1, at: now, policyId: config.policyId });
    return persistDenial(input, { blocked: true, category: matched.category, policyId: config.policyId,
      reason: privateOnly ? 'private_channel_required' : 'restricted_request',
      reply: privateOnly ? '这类内部资料不能发到当前渠道，请在已核验的私聊中查询。' : ACCESS_REFUSAL }, stateRoot, now);
  });
  if (!decision?.business) return decision;
  // Network work must not hold the short local decision-commit queue.
  let reply;
  try { reply = await limitedInterviewReply(interviewConfig, input, { now }); }
  catch { reply = '受限候选人查询暂时不可用，本条没有交给普通问答模型。请稍后重试。'; }
  return {...decision, reply: reply + (decision.reply ? '\n\n' + decision.reply : '')};
}
