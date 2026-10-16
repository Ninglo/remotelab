// A model proposes a concrete packet. Only a verified native question answer
// can approve it; the existing execution-plan/outbox owns the actual work.
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { normalizeFeishuProjectLinks } from '../connectors/feishu/linked-project-context.mjs';
import { sanitizeIdPart } from '../connectors/feishu/index.mjs';
import { readRecord } from '../lib/durable-records.mjs';
import { createParticipationController, participationEnabled } from '../connectors/feishu/participation-state.mjs';
import { normalizeFeishuGroups } from '../connectors/feishu/group-settings.mjs';
import { findSessionMeta, loadSessionsMeta, mutateSessionMeta } from './session-meta-store.mjs';
import { verifiedWorkActor } from './work-awareness.mjs';
import { requests } from './requests.mjs';
import { createKeyedTaskQueue } from './fs-utils.mjs';
import { appendEvent } from './history.mjs';

const serial = createKeyedTaskQueue();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20);
const fail = message => { throw new Error(message); };
const clean = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const proposals = source => source?.workAwareness?.kickoffs || [];
export const KICKOFF_CHOICES = ['移交干活群并开工', '继续讨论', '暂不开展'];
const sameGroup = (a, b) => a?.connector === 'feishu' && b?.connector === 'feishu'
  && a.sourceRouteId === b.sourceRouteId && a.target?.chatId === b.target?.chatId
  && a.target?.tenantKey === b.target?.tenantKey;
async function save(sourceId, change) {
  await mutateSessionMeta(sourceId, source => {
    source.workAwareness ||= { version: 1, revision: 0, works: [], intents: [], suggestions: [] };
    source.workAwareness.kickoffs ||= [];
    change(source.workAwareness.kickoffs);
    source.workAwareness.revision++;
    return true;
  });
}
async function registration(origin) {
  if (origin?.connector !== 'feishu' || !origin.sourceRouteId || !origin.target?.tenantKey) fail('A verified Feishu group origin is required');
  const registry = await readRecord(join(CONFIG_DIR, 'feishu-bots.json'));
  const standard = origin.sourceRouteId === 'default' ? join(CONFIG_DIR, 'feishu-connector', 'config.json')
    : join(CONFIG_DIR, 'feishu-connectors', sanitizeIdPart(origin.sourceRouteId), 'config.json');
  const paths = [...new Set([standard, ...(registry?.bots || []).filter(b => b.id === origin.sourceRouteId).map(b => b.configPath)])];
  const matches = [];
  for (const path of paths) {
    if (!isAbsolute(path || '')) continue;
    const raw = await readRecord(path);
    if (!raw) continue;
    const route = raw.botId ? sanitizeIdPart(raw.botId) : path === join(CONFIG_DIR, 'feishu-connector', 'config.json') ? 'default' : sanitizeIdPart(basename(dirname(path)));
    if (route === origin.sourceRouteId) matches.push({ raw, path });
  }
  if (matches.length !== 1) fail('The registered connector configuration is missing or ambiguous');
  const { raw, path } = matches[0];
  const link = normalizeFeishuProjectLinks(raw.projectLinks).find(l => l.discussionChatId === origin.target.chatId);
  if (!link) fail('No registered discussion-to-work project relationship');
  const target = { connector: 'feishu', sourceRouteId: origin.sourceRouteId,
    target: { chatId: link.workChatId, tenantKey: origin.target.tenantKey, chatType: 'group', conversationKind: 'thread' } };
  return { target, projectId: link.projectId, targetName: link.workChatName || link.workChatId, connectorConfigPath: path };
}
async function participation(origin, configPath) {
  const raw = await readRecord(configPath);
  if (!raw) fail('Participation configuration is unavailable');
  const config = { ...raw, sourceRouteId: origin.sourceRouteId, storageDir: raw.storageDir || dirname(configPath),
    groups: normalizeFeishuGroups(raw.groups) };
  // Config path is operator-owned registration, never a tool payload path.
  if (raw.botId && sanitizeIdPart(raw.botId) !== origin.sourceRouteId) fail('Participation configuration belongs to another route');
  const runtime = { config }, summary = { ...origin.target };
  if (!participationEnabled(runtime, summary)) fail('Group participation controls are not enabled');
  return createParticipationController(runtime).state(summary);
}
async function actorFor(record) {
  const o = record?.options || {};
  const actor = verifiedWorkActor(o.viewPersonId, o.initiatedByIdentityId);
  if (!actor || record.result || record.releasedAt || o.internalOperation || o.automationTitle
      || o.recordUserMessage === false || o.workPlanChild || o.workPlanReview
      || o.feishuConnectorAuthenticated !== true || o.sourceContext?.connector !== 'feishu'
      || ['app', 'bot'].includes(o.sourceContext?.sender?.senderType)) fail('Kickoff requires a current accepted human Feishu input');
  const source = await findSessionMeta(record.sessionId);
  const origin = record.deliveryPlan || o.sourceDelivery;
  if (!source || source.archived || !sameGroup(source.conversation, origin)) fail('Kickoff source conversation changed');
  return { actor, source, origin };
}
export function kickoffQuestion(p) {
  return { title: [ `是否将这项讨论移交干活群开工？（建议第 ${p.version} 版）`, `目标：${p.goal}`, `已定方案与范围：${p.plan}`,
    `来源：${p.sources}`, `未决项：${p.unresolved}`, `目标干活群：${p.targetName}（${p.target.target.chatId}）`,
    `验收：${p.acceptance}`, '确认后才创建独立话题并启动，结果回到本讨论；继续讨论、暂不开展或未回答均不开工。' ].join('\n\n'),
    options: KICKOFF_CHOICES };
}
export async function handleWorkKickoff(record, body, deps) {
  if (!['propose', 'resume'].includes(body.action)) fail('Use kickoff propose or resume; approval is a native human answer only');
  const result = await serial(record.sessionId, async () => {
    record = await requests.get(record.key) || record;
    const { actor, source, origin } = await actorFor(record);
    if (body.action === 'resume') {
      const p = proposals(source).find(p => p.id === body.proposalId && p.actor.personId === actor.personId);
      if (!p || p.state !== 'approved') fail('Only an already human-approved kickoff can resume');
      return { proposal: p };
    }
    const reg = await registration(origin);
    if (source.delegatedFromSessionId || source.delegationDepth) fail('A delegated child cannot propose discussion kickoff');
    const status = await participation(origin, reg.connectorConfigPath);
    const targetStatus = await participation(reg.target, reg.connectorConfigPath);
    if (status.mode !== 'active' || targetStatus.mode !== 'active') fail('Kickoff proposals require active participation');
    const packet = Object.fromEntries(['goal', 'plan', 'sources', 'unresolved', 'acceptance'].map(key => [key, clean(body[key], key === 'goal' ? 600 : 4000)]));
    if (Object.values(packet).some(v => !v)) fail('Provide goal, plan, sources, unresolved items (or none), and acceptance');
    // Same concrete proposal remains one card across input retries/new messages.
    const fingerprint = hash([source.id, actor.personId, packet, reg.target, reg.targetName, reg.projectId, status.epoch, targetStatus.epoch]);
    const old = proposals(source).findLast(p => p.fingerprint === fingerprint);
    if (old && old.state !== 'superseded') return { proposal: old, question: old.state === 'draft' ? kickoffQuestion(old) : null, duplicate: true };
    const p = { id: 'kickoff_' + (old ? hash([fingerprint, old.id]) : fingerprint), fingerprint, version: proposals(source).length + 1, ...packet, state: 'draft', actor,
      sourceSessionId: source.id, sourceRequestId: record.requestId, createdAt: new Date().toISOString(),
      origin, target: reg.target, targetName: reg.targetName, folder: source.folder, projectId: reg.projectId,
      sourceEpoch: status.epoch, targetEpoch: targetStatus.epoch, runtimeSelection: record.runtimeSelection };
    await save(source.id, items => {
      for (const old of items) if (old.actor.personId === actor.personId && old.state === 'draft') old.state = 'superseded';
      items.push(p);
    });
    await appendEvent(source.id, { type: 'work_event', action: 'kickoff-proposed', proposalId: p.id });
    return { proposal: p, question: kickoffQuestion(p) };
  });
  if (body.action === 'resume') {
    const { startConfirmedWorkKickoff } = await import('./work-execution-plans.mjs');
    return { ...result, execution: await startConfirmedWorkKickoff(record.sessionId, result.proposal.id, deps) };
  }
  return result;
}
// Called ONLY during admission from the server-read pending native question.
// Full preview AND exact choices are bound, including custom text / numeric answers.
export function kickoffQuestionDecision(source, question, values) {
  if (values.length !== 1 || !KICKOFF_CHOICES.includes(values[0]) || question?.multiSelect
      || JSON.stringify(question.options?.map(o => o.label)) !== JSON.stringify(KICKOFF_CHOICES)) return null;
  const found = proposals(source).filter(p => p.state === 'draft' && kickoffQuestion(p).title === question.question);
  return found.length === 1 ? { proposalId: found[0].id, choice: values[0] } : null;
}
export async function validateWorkKickoffPlan(sourceId, proposalId) {
  const source = await findSessionMeta(sourceId), p = proposals(source).find(p => p.id === proposalId);
  if (!p || source.archived || p.state !== 'approved') fail('Kickoff is no longer approved');
  const reg = await registration(p.origin);
  if (JSON.stringify(reg.target) !== JSON.stringify(p.target) || reg.targetName !== p.targetName || reg.projectId !== p.projectId) fail('Registered work group changed; review a fresh kickoff');
  const status = await participation(p.origin, reg.connectorConfigPath), targetStatus = await participation(p.target, reg.connectorConfigPath);
  if (status.mode !== 'active' || status.epoch !== p.sourceEpoch
      || targetStatus.mode !== 'active' || targetStatus.epoch !== p.targetEpoch) fail('Participation mode changed; review a fresh kickoff');
  return p;
}
export async function acceptWorkKickoff(record, deps) {
  // No text parser or work API accepts approval. This field is derived by the
  // server from its own pending question, not copied from HTTP request bodies.
  const decision = record.options?.workKickoffDecision;
  if (!decision || !record.options.nativeQuestionId) return '';
  const p = await serial(record.sessionId, async () => {
    const source = await findSessionMeta(record.sessionId);
    const current = proposals(source).find(p => p.id === decision.proposalId);
    if (!current || current.actor.personId !== record.options.viewPersonId || !KICKOFF_CHOICES.includes(decision.choice)) fail('Kickoff decision does not match its original requester');
    if (current.decisionRequestId === record.requestId) return current;
    const { origin } = await actorFor(record);
    if (!sameGroup(origin, current.origin) || current.state !== 'draft' || current.sourceRequestId === record.requestId
        || Date.parse(record.acceptedAt) < Date.parse(current.createdAt)) fail('Kickoff needs a subsequent answer to the current proposal');
    const state = decision.choice === KICKOFF_CHOICES[0] ? 'approved' : decision.choice === KICKOFF_CHOICES[1] ? 'discussing' : 'declined';
    if (state === 'approved') {
      // Validate before recording approval; mode changes never turn an old card
      // into a new invitation. Returning to active still has a different epoch.
      const reg = await registration(current.origin);
      const a = await participation(current.origin, reg.connectorConfigPath), b = await participation(current.target, reg.connectorConfigPath);
      if (a.mode !== 'active' || a.epoch !== current.sourceEpoch || b.mode !== 'active' || b.epoch !== current.targetEpoch
          || JSON.stringify(reg.target) !== JSON.stringify(current.target) || reg.targetName !== current.targetName || reg.projectId !== current.projectId) fail('Participation mode or target changed; review a fresh kickoff');
    }
    const next = { ...current, state, decisionRequestId: record.requestId, questionId: record.options.nativeQuestionId,
      decisionAt: new Date().toISOString(), choice: decision.choice };
    await save(source.id, items => Object.assign(items.find(p => p.id === current.id), next));
    await appendEvent(source.id, { type: 'work_event', action: 'kickoff-decided', proposalId: current.id, state, requestId: record.requestId });
    return next;
  });
  if (p.state !== 'approved') return p.state === 'discussing' ? '继续在本话题讨论，未创建工作话题。' : '已暂缓，未创建工作话题。';
  const { startConfirmedWorkKickoff } = await import('./work-execution-plans.mjs');
  const plan = await startConfirmedWorkKickoff(record.sessionId, p.id, deps);
  return plan.branches[0].state === 'running' ? '已在干活群创建话题并提交执行。' : '已记录开工确认；工作话题送达并绑定后才开始执行。';
}

export async function recoverWorkKickoffs(deps) {
  // Covers a crash after the human decision but before plan creation. Existing
  // plan recovery handles topic delivery, execution and results thereafter.
  for (const source of await loadSessionsMeta()) for (const p of proposals(source)) {
    if (source.archived || p.state !== 'approved' || source.workAwareness?.executionPlans?.some(plan => plan.workKickoff?.proposalId === p.id)) continue;
    try {
      const { startConfirmedWorkKickoff } = await import('./work-execution-plans.mjs');
      await startConfirmedWorkKickoff(source.id, p.id, deps);
    } catch (error) {
      await appendEvent(source.id, { type: 'work_event', action: 'kickoff-recovery-failed', proposalId: p.id, error: error.message });
    }
  }
}
