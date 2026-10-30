// Aggregate existing input/decision/delivery records only. No model calls or writes.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { businessStart, businessDate, DAY } from './monitoring-dashboard.mjs';
import { timingStats } from './response-timing.mjs';
import { effectiveFeishuGroup } from '../connectors/feishu/group-settings.mjs';
import { classifyMessageOrigin, projectInbox, projectMessageSource, sourceKey } from './monitoring-message-origin.mjs';

const time = v => v == null ? NaN : typeof v === 'number' ? v : /^\d{13}$/.test(v) ? Number(v) : Date.parse(v);
const inWindow = (at, start, end) => time(at) >= start && time(at) <= end;
const latency = (start, end) => Number.isFinite(time(start)) && time(end) >= time(start) ? time(end) - time(start) : null;
const visible = new Set(['opening', 'progress', 'reply', 'question', 'final']);
const mode = v => v === 'listening' ? 'paused' : ['active', 'paused'].includes(v) ? v : 'unknown';
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o?.[k] !== undefined).map(k => [k, o[k]]));
const scope = (route, chatId) => sourceKey(route, chatId);
const requestKey = r => JSON.stringify([r.sessionId, r.requestId]);
const sourceId = (route, s) => sourceKey(route, s?.messageId);

export function projectGroupRequest(r) {
  const contract = r.mainlineReply?.contract;
  return { sessionId: r.sessionId, requestId: r.requestId, runId: r.runId, nativeDispatchRunId: r.nativeDispatchRunId,
    state: r.result?.state || 'pending', settledAt: r.settledAt, acceptedAt: r.acceptedAt,
    source: projectMessageSource(r.options?.sourceContext),
    noText: Boolean(contract?.noTextReason), hasText: Boolean(contract?.payload?.text?.trim()),
    ownerRequestId: contract?.ownerRequestId, replyRequestIds: contract?.requestIds || [],
    handedOff: r.routingHandoff?.state === 'submitted',
    deliveries: (r.deliveries || []).filter(d => d.connector === 'feishu').map(d => ({
      ...pick(d, ['id', 'kind', 'state', 'surfaceKind', 'publicationRequestId', 'createdAt', 'deliveredAt', 'externalId',
        'deliveredMessageId', 'deliveredThreadId', 'processingState', 'emojiType', 'sourceRouteId']),
      target: { ...projectMessageSource(d.target), ...pick(d.target, ['replyInThread']) },
    })) };
}
async function storeRecords(root, read, project, coverage) {
  const files = new Set();
  for (const part of ['active', 'archive']) {
    try { for (const f of await readdir(join(root, part))) if (/^[a-f0-9]+\.json$/.test(f)) files.add(f); }
    catch (e) { if (e.code !== 'ENOENT') { coverage.storeErrors++; } }
  }
  const rows = [], names = [...files];
  for (let i = 0; i < names.length; i += 8) await Promise.all(names.slice(i, i + 8).map(async f => {
    const value = await read(join(root, 'active', f), project) || await read(join(root, 'archive', f), project);
    if (value) rows.push(value); else coverage.unreadRecords++;
  }));
  return rows;
}

export async function collectGroupMonitoring({ connectors, read, requestFor, deliveryFor = async () => null, sessions, ledger, now, coverage, requests = [] }) {
  const start = businessStart(now) - 6 * DAY;
  const c = { connectors: connectors.length, storeErrors: 0, unreadRecords: 0, missingRequests: 0,
    unknownOrigins: 0, missingMessageTimes: 0, excludedTopicInputs: 0 };
  const inputs = [], groups = [], reactions = [], requestMap = new Map(requests.map(r => [requestKey(r), r.group]));
  for (const connector of connectors) {
    const route = connector.sourceRouteId;
    const beforeStateErrors = c.unreadRecords + c.storeErrors;
    const states = await storeRecords(join(connector.storageDir, 'participation-state'), read,
      r => ({ source: projectMessageSource(r.source), mode: r.mode, modeOverride: r.modeOverride, updatedAt: r.updatedAt }), c);
    const settings = await storeRecords(join(connector.storageDir, 'conversation-settings'), read,
      r => ({ scope: r.scope, muted: r.muted }), c);
    const stateComplete = beforeStateErrors === c.unreadRecords + c.storeErrors;
    const inbox = await storeRecords(join(connector.storageDir, 'inbox'), read, projectInbox, c);
    const ids = new Set([...Object.keys(connector.groups || {}), ...states.filter(r => !r.source?.topicId && !r.source?.threadId).map(r => r.source?.chatId)].filter(Boolean));
    for (const chatId of ids) {
      const observed = inbox.find(r => r.source.chatId === chatId && r.source.chatType === 'group');
      if (!observed && !Object.hasOwn(connector.groups || {}, chatId)) continue;
      // Native topic groups are ordinary conversation inputs, not a main timeline.
      if (observed && ['topic'].includes(observed.source.chatMode)) continue;
      const config = effectiveFeishuGroup(connector, chatId);
      const state = states.find(r => r.source?.chatId === chatId && !r.source.topicId && !r.source.threadId);
      const muted = settings.find(r => r.scope?.chatId === chatId && !r.scope.topicId)?.muted === true;
      const override = state && (state.modeOverride === true || state.modeOverride === undefined && (state.updatedAt || ['listening', 'paused'].includes(state.mode)));
      const enabled = config.participationMode === 'ambient' && config.participationControls === true;
      groups.push({ id: scope(route, chatId), enabled,
        mode: !stateComplete ? 'unknown' : muted ? 'paused' : enabled ? mode(override ? state.mode : config.initialParticipationMode || 'active') : 'unknown' });
    }
    for (const item of inbox) {
      const s = item.source;
      if (s.chatType !== 'group' || !s.messageId || s.sourceKind || ['bot', 'app'].includes(s.senderType)) continue;
      if (!Number.isFinite(time(s.createTime))) { c.missingMessageTimes++; continue; }
      if (!inWindow(s.createTime, start, now)) continue;
      const origin = classifyMessageOrigin(s, true);
      if (origin.kind === 'ordinary') { c.excludedTopicInputs++; continue; }
      if (origin.kind !== 'group-mainline') { c.unknownOrigins++; continue; }
      const input = { ...item, route, id: sourceId(route, s), groupId: scope(route, s.chatId), at: time(s.createTime) };
      inputs.push(input);
      if (item.sessionId && item.requestId && !['observed', 'skipped', 'control'].includes(item.intake)) {
        const r = await requestFor(item.sessionId, item.requestId);
        if (r) requestMap.set(requestKey(r), r.group); else c.missingRequests++;
      }
    }
    // Optional social feedback can precede a Request or accompany observation-only inputs.
    const outcomes = await storeRecords(join(connector.storageDir, 'outcome-reactions'), read,
      r => pick(r, ['messageId', 'reactionId', 'sequence', 'revision', 'withdrawn']), c);
    for (const r of outcomes) if (r.reactionId && !r.withdrawn) reactions.push({
      sourceId: sourceKey(route, r.messageId), id: sourceKey(route, r.reactionId),
      // sequence survives replacements: only an untouched create establishes its timestamp.
      at: r.revision === 1 ? r.sequence : null, kind: 'social', basis: 'outcome-store',
    });
  }
  // A combined reply has one owner. Load that exact owner, never duplicate its outbox.
  for (const r of [...requestMap.values()]) if (r.ownerRequestId && r.ownerRequestId !== r.requestId) {
    const key = requestKey({ ...r, requestId: r.ownerRequestId });
    if (!requestMap.has(key)) {
      const owner = await requestFor(r.sessionId, r.ownerRequestId);
      if (owner) requestMap.set(key, owner.group); else c.missingRequests++;
    }
  }
  const inputRequests = new Map(inputs.map(m => [requestKey(m), m])), bySession = new Map(sessions.map(s => [s.id, s]));
  const topics = new Map(); c.topicReceiptMissing = 0;
  const addTopic = (m, target, d) => {
    if (!d || d.state !== 'delivered' || !d.deliveredThreadId || !d.externalId || time(d.deliveredAt) > now) { c.topicReceiptMissing++; return; }
    const id = scope(d.sourceRouteId || m.route, d.target?.chatId) + ':' + d.deliveredThreadId;
    const existing = topics.get(id);
    const t = { id, sourceId: m.id, at: time(d.deliveredAt), sessionId: target.id };
    if (!existing || t.at < existing.at) topics.set(id, t);
  };
  for (const s of sessions) {
    for (const route of s.groupRouting?.routes || []) {
      const target = bySession.get(route.targetSessionId), t = target?.conversation?.target;
      if (route.state !== 'submitted' || !String(target?.externalTriggerId || '').startsWith('routing-pilot:')) continue;
      const m = (route.requestIds || []).map(requestId => inputRequests.get(requestKey({ sessionId: s.id, requestId }))).find(m => m && [t?.messageId, t?.rootId].includes(m.source.messageId));
      if (!m) continue;
      const r = await requestFor(target.id, 'routed:' + m.requestId);
      const d = r?.group.deliveries.filter(d => d.kind === 'content' && d.state === 'delivered').sort((a,b) => time(a.deliveredAt)-time(b.deliveredAt))[0];
      addTopic(m, target, d);
    }
    for (const plan of s.workAwareness?.executionPlans || []) {
      const m = inputRequests.get(requestKey({ sessionId: s.id, requestId: plan.sourceRequestId }));
      if (!m || plan.branchSurface !== 'feishu-thread') continue;
      for (const b of plan.branches || []) {
        const target = bySession.get(b.sessionId);
        if (!target || !String(target.externalTriggerId || '').startsWith('work-plan:')) continue;
        addTopic(m, target, b.topicDeliveryId ? await deliveryFor(b.topicDeliveryId) : null);
      }
    }
  }
  return aggregateGroupMonitoring({ inputs, requests: [...requestMap.values()], reactions, topics: [...topics.values()], groups, sessions, ledger, now,
    coverage: { ...c, bytesRead: coverage.bytesRead, cacheHits: coverage.cacheHits, limitedFiles: coverage.limitedFiles, readErrors: coverage.readErrors,
      partial: c.storeErrors > 0 || c.unreadRecords > 0 || coverage.limitedFiles > 0 || coverage.readErrors > 0 } });
}

export function aggregateGroupMonitoring({ inputs, requests = [], reactions = [], topics = [], groups = [], sessions = [], ledger = [], now, coverage = {} }) {
  const start = businessStart(now) - 6 * DAY;
  inputs = [...new Map(inputs.filter(m => inWindow(m.at, start, now)).map(m => [m.id, m])).values()];
  const byInput = new Map(inputs.map(m => [m.id, m])), byRequest = new Map(requests.map(r => [requestKey(r), r]));
  const requestInputs = new Map(inputs.filter(m => m.requestId && m.sessionId).map(m => [requestKey(m), m]));
  const text = new Map(), emoji = new Map(), unknownReceipts = new Set(), unattributed = new Set(), failedDeliveries = new Set();
  const relatedRequests = new Map();
  for (const r of requests) {
    const input = requestInputs.get(requestKey(r));
    if (input) relatedRequests.set(requestKey(r), input);
  }
  for (const r of requests) for (const d of r.deliveries || []) {
    const owner = relatedRequests.get(requestKey({ ...r, requestId: d.publicationRequestId || r.requestId }));
    const targetInput = byInput.get(sourceKey(d.sourceRouteId || r.source?.sourceRouteId, d.target?.messageId));
    const m = d.publicationRequestId ? owner : owner || targetInput;
    if (!m) {
      if (relatedRequests.has(requestKey(r)) && d.kind === 'content' && d.state === 'delivered')
        unattributed.add(sourceKey(d.sourceRouteId || r.source?.sourceRouteId, d.deliveredMessageId || d.externalId || d.id));
      continue;
    }
    if (d.kind === 'content' && d.state === 'failed') failedDeliveries.add(m.id);
    if (d.state !== 'delivered') continue;
    const external = d.deliveredMessageId || d.externalId;
    if (!external) { if (d.kind === 'content') unknownReceipts.add(d.id); continue; }
    const id = sourceKey(d.sourceRouteId || m.route, external);
    if (d.kind === 'reaction') {
      if (d.processingState === 'finished' || d.emojiType === null) continue;
      const value = { id, sourceId: m.id, at: time(d.deliveredAt), kind: d.processingState === 'active' ? 'processing' : 'social', basis: 'request' };
      if (!emoji.has(id) || value.at < emoji.get(id).at) emoji.set(id, value);
      continue;
    }
    const kind = d.surfaceKind || (time(d.createdAt) >= time(r.settledAt) ? 'final' : '');
    if (d.kind !== 'content' || !visible.has(kind)) continue;
    const t = d.target || {};
    let placement = 'unknown';
    const threadId = d.deliveredThreadId;
    if (t.chatId === m.source.chatId) {
      if (t.sourceKind === 'ambient_thread_open' || t.startThread === true
          || t.replyInThread === true && !t.threadId && (!t.rootId || t.rootId === m.source.messageId)) {
        if (threadId) placement = 'newThread';
      } else if (t.conversationKind === 'main' && !t.replyInThread && !t.threadId) placement = 'inline';
      else if (t.threadId || t.conversationKind === 'thread') placement = 'existingThread';
    }
    const value = { id, sourceId: m.id, at: time(d.deliveredAt), placement, threadId, groupId: m.groupId };
    if (!text.has(id) || value.at < text.get(id).at) text.set(id, value);
  }
  for (const r of reactions) if (byInput.has(r.sourceId) && !emoji.has(r.id)) emoji.set(r.id, r);
  const texts = [...text.values()].filter(d => d.at <= now);
  const emojis = [...emoji.values()].filter(d => !Number.isFinite(d.at) || d.at <= now);
  const ownedTexts = new Map();
  for (const d of texts) { if (!ownedTexts.has(d.sourceId)) ownedTexts.set(d.sourceId, []); ownedTexts.get(d.sourceId).push(d); }
  const inputStates = inputs.map(m => {
    const r = byRequest.get(requestKey(m));
    const owner = r?.ownerRequestId && r.replyRequestIds?.includes(r.requestId) && r.replyRequestIds.includes(r.ownerRequestId)
      ? requestInputs.get(requestKey({ ...r, requestId: r.ownerRequestId })) : m;
    const covered = ownedTexts.has(m.id) || owner && ownedTexts.has(owner.id);
    // These buckets are exclusive; no-receipt is not a no-text decision.
    const outcome = m.intake === 'failed' || ['failed', 'cancelled'].includes(r?.state) || failedDeliveries.has(m.id) ? 'failed'
      : covered || m.intake === 'control' || r?.handedOff ? 'processed'
      : m.intake === 'observed' || m.intake === 'skipped' || r?.noText && !r.hasText ? 'noReply'
      : r && r.state === 'pending' || !m.complete ? 'processing' : 'unconfirmed';
    return { ...m, outcome, covered: Boolean(covered), merged: Boolean(covered && owner && owner.id !== m.id),
      request: r, runId: r?.nativeDispatchRunId || r?.runId || m.runId };
  });
  const feeds = new Set(sessions.filter(s => s.groupFeed || String(s.externalTriggerId || '').startsWith('feishu:group-feed:')).map(s => s.id));
  const sessionById = new Map(sessions.map(s => [s.id, s]));
  const runInputs = new Map();
  for (const m of inputStates) if (m.runId) {
    if (!runInputs.has(m.runId)) runInputs.set(m.runId, []); runInputs.get(m.runId).push(m);
  }
  // Share the corrected, Run-deduplicated ledger returned by the existing query.
  // Explicitly exclude child/related work Sessions even if the first input came from a group.
  const included = [], excludedRelated = [];
  for (const r of new Map(ledger.map(r => [r.runId, r])).values()) {
    if (!inWindow(r.ts, start, now)) continue;
    const linked = runInputs.get(r.runId) || [];
    const main = feeds.has(r.sessionId) || String(sessionById.get(r.sessionId)?.externalTriggerId || '').startsWith('feishu:main:')
      && linked.some(m => m.sessionId === r.sessionId && (!m.workSessionId || m.workSessionId === m.originSessionId));
    if (main) included.push(r); else if (linked.length) excludedRelated.push(r);
  }
  const measured = new Set(included.filter(r => Number.isFinite(r.totalTokens)).map(r => r.runId));
  function summarize(rows, at, end) {
    const ids = new Set(rows.map(m => m.id)), ts = texts.filter(d => ids.has(d.sourceId)), es = emojis.filter(d => ids.has(d.sourceId));
    const first = (ds, kind) => [...new Set(ds.filter(d => !kind || d.kind === kind).map(d => d.sourceId))].map(id => {
      const times = ds.filter(d => d.sourceId === id && (!kind || d.kind === kind)).map(d => d.at).filter(Number.isFinite);
      return times.length ? latency(byInput.get(id).at, Math.min(...times)) : null;
    });
    const usage = included.filter(r => inWindow(r.ts, at, end));
    const stats = { received: rows.length, groupsWithInput: new Set(rows.map(m => m.groupId)).size };
    for (const state of ['processed', 'noReply', 'failed', 'processing', 'unconfirmed']) stats[state] = rows.filter(m => m.outcome === state).length;
    return { ...stats, observed: rows.filter(m => m.intake === 'observed').length, skipped: rows.filter(m => m.intake === 'skipped').length,
      explicitNoText: rows.filter(m => m.request?.noText && !m.request.hasText).length,
      withTextReceipt: rows.filter(m => m.covered).length, mergedInputs: rows.filter(m => m.merged).length,
      withoutTextReceipt: rows.filter(m => !m.covered).length,
      inlineReplies: ts.filter(d => d.placement === 'inline').length,
      newThreadReplies: ts.filter(d => d.placement === 'newThread').length,
      newThreads: new Set([...ts.filter(d => d.placement === 'newThread').map(d => d.groupId + ':' + d.threadId),
        ...topics.filter(t => ids.has(t.sourceId) && t.at <= now).map(t => t.id)]).size,
      newWorkSessions: new Set(topics.filter(t => ids.has(t.sourceId) && t.at <= now).map(t => t.sessionId)).size,
      existingThreadReplies: ts.filter(d => d.placement === 'existingThread').length,
      unknownPlacementReplies: ts.filter(d => d.placement === 'unknown').length,
      textReceipts: ts.length, reactionReceipts: es.filter(d => d.kind === 'social').length,
      processingReceipts: es.filter(d => d.kind === 'processing').length,
      textLatency: timingStats(first(ts)), topicLatency: timingStats(first(topics.filter(t => ids.has(t.sourceId) && t.at <= now))),
      reactionLatency: timingStats(first(es, 'social')), processingLatency: timingStats(first(es, 'processing')),
      reactionTimeUnknown: es.filter(d => d.kind === 'social' && !Number.isFinite(d.at)).length,
      usage: { runs: usage.length, totalTokens: usage.reduce((n, r) => n + (r.totalTokens || 0), 0),
        cachedInputTokens: usage.reduce((n, r) => n + (r.cachedInputTokens || 0), 0),
        unmeteredInputs: rows.filter(m => m.intake === 'accepted' && !measured.has(m.runId)).length,
        unmatchedRuns: usage.filter(r => !runInputs.has(r.runId)).length } };
  }
  const days = Array.from({ length: 7 }, (_, i) => {
    const at = start + i * DAY, end = Math.min(now, at + DAY - 1);
    return { day: businessDate(at), ...summarize(inputStates.filter(m => m.at >= at && m.at <= end), at, end) };
  });
  const states = [...new Map(groups.map(g => [g.id, g])).values()];
  return { schema: 1, generatedAt: new Date(now).toISOString(), start: new Date(start).toISOString(),
    timezone: 'Asia/Shanghai', dayStartHour: 5, scope: 'original-group-mainline',
    current: { enabledGroups: states.filter(g => g.enabled).length,
      ...Object.fromEntries(['active', 'paused', 'unknown'].map(m => [m, states.filter(g => g.enabled && mode(g.mode) === m).length])) },
    today: days.at(-1), days, totals: summarize(inputStates, start, now),
    coverage: { ...coverage, textWithoutProviderId: unknownReceipts.size, unattributedTextReceipts: unattributed.size,
      textTimeUnknown: [...text.values()].filter(d => !Number.isFinite(d.at)).length, failedDeliveryInputs: failedDeliveries.size, excludedRelatedRuns: excludedRelated.length },
    semantics: [
      '原始入站消息为普通群主线、人工发言，按消息发送日归集；原生话题群和话题续聊归普通会话。北京时间 05:00 分日；当前有效参与群数限已配置或有主线参与状态的群，依据本次配置与持久状态，不代表平台成员资格或历史状态。',
      '处理／不回复／失败／处理中／待确认互斥。处理含文字覆盖、参与控制和已接纳转交；失败含执行失败、取消及文字投递失败。不回复须有历史旁听记录、跳过或明确无文字决定；其余已结束且无回执的请求为待确认。',
      '文字和表情按实际外部回执 ID 去重；新话题须有实际 thread ID 与开话题目标，含明确关联的新工作话题建立回执，已存在话题单列。工作话题建立时延单列，不当作原输入已完成。合并回复覆盖多条输入，但文字回执及首响只归所属输入一次。',
      '文字首响含开场、进展、答复、提问和最终回复，时延从所属原消息发出计至平台送达；社交表情与自动处理提示分开，删除表情不计。历史表情替换缺少可靠时间时保留空缺。',
      '群消耗复用原账本纠错与 Run 去重，仅群主线运行；关联或转交的工作 Session 消耗排除，属于全实例总量的子集，不能再相加。Token 按记账日，消息按发送日；未计量输入与缺来源 Run 单列。没有来源关联的后台辅助调用不分摊到群。',
    ] };
}
