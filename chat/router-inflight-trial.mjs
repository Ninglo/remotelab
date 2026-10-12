import { createHash } from 'node:crypto';
import { readBody } from '../lib/utils.mjs';
import { canonicalJson, serialQueue } from '../lib/durable-records.mjs';
import { normalizeConversation, sameConversation } from '../lib/conversation-target.mjs';
import { buildReplyDeliveries } from '../lib/reply-deliveries.mjs';
import { requests, appendDeliveries } from './requests.mjs';
import { appendEvent, loadHistory } from './history.mjs';
import { inflightTrialEnabled, loadInflightTrial } from './inflight-trial.mjs';

const fail = (message, status = 403) => { throw Object.assign(new Error(message), { status }); };
const live = record => record && !record.result && !record.releasedAt && !record.cancelRequestedAt;
const planFor = record => normalizeConversation(record.deliveryPlan || record.options?.sourceDelivery);

// One owner for this optional publication tool. Input admission/steer and native
// publication keep their existing paths. The durable root owns the outbox receipt.
export function createInflightTrialTools({ store = requests, history = sessionId => loadHistory(sessionId, { includeBodies: false }), append = appendEvent,
  settings = loadInflightTrial, cancel = async (sessionId, options) =>
    (await import('./session-manager.mjs')).cancelActiveRun(sessionId, options) } = {}) {
  const serial = serialQueue();
  return (action, input, authSession) => serial(async () => {
    if (!input || typeof input.runId !== 'string' || typeof input.sourceRequestId !== 'string') fail('需要当前运行和输入地址。', 400);
    const root = await store.byRunId(input.runId);
    const source = root && await store.byRequest(root.sessionId, input.sourceRequestId);
    const belongs = record => record && (record.key === root.key || record.nativeDispatchRunId === root.runId && record.nativeReceipt?.accepted)
      && inflightTrialEnabled(record.options) && record.options.viewPersonId === root.options.viewPersonId
      && sameConversation(planFor(record), planFor(root));
    if (!root || !inflightTrialEnabled(root.options) || !belongs(source)
        || authSession?.authKind !== 'service' && authSession?.personId !== source.options.viewPersonId) fail('试用仅限本人发起的任务和已接受的本人输入。');
    const actor = { personId: source.options.viewPersonId, identityId: source.options.initiatedByIdentityId };
    if (!(await settings(actor)).enabled) fail('个人试用已关闭。');
    const events = await history(root.sessionId);
    if (action === 'inspect') {
      const ids = new Set([root.requestId, ...events.filter(event => event.role === 'user' && event.requestId).map(event => event.requestId)]);
      const inputs = [];
      for (const id of ids) {
        const record = await store.byRequest(root.sessionId, id);
        if (!belongs(record)) continue;
        inputs.push({ requestId: id, acceptedAt: record.acceptedAt,
          ...(input.includeText === true ? { text: record.text } : {}) });
      }
      const questions = new Map();
      for (const event of events) if (event.runId === root.runId && event.questionId) {
        questions.set(event.questionId, { questionId: event.questionId, state: event.questionState,
          question: event.nativeQuestion || questions.get(event.questionId)?.question });
      }
      return { runId: root.runId, active: Boolean(live(root)), inputs,
        unansweredQuestions: [...questions.values()].filter(q => ['pending', 'superseded'].includes(q.state)),
        replies: root.inflightTrialReplies || [],
        deliveries: (root.deliveries || []).filter(d => d.inflightTrialReplyId).map(d => ({
          replyId: d.inflightTrialReplyId, id: d.id, state: d.state, externalId: d.externalId, lastError: d.lastError })) };
    }
    if (action === 'stop') {
      if (input.expectedRunId !== root.runId) fail('停止目标与当前运行不一致。', 409);
      if (!live(root)) return { runId: root.runId, cancelRequested: Boolean(root.cancelRequestedAt), result: root.result };
      return { runId: root.runId, cancellation: await cancel(root.sessionId, { expectedRunId: root.runId }) };
    }
    if (action !== 'reply') fail('未知试用操作。', 400);
    if (!/^[a-zA-Z0-9_-]{1,96}$/.test(input.replyId || '') || typeof input.text !== 'string'
        || !input.text.trim() || input.text.length > 24000 || !Array.isArray(input.requestIds)
        || !input.requestIds.length || input.requestIds.length > 32
        || input.requestIds.some(id => typeof id !== 'string')) fail('答复需要固定 replyId、正文和输入地址列表。', 400);
    const packet = { sourceRequestId: source.requestId, replyId: input.replyId,
      requestIds: [...new Set(input.requestIds)].sort(), text: input.text };
    if (!packet.requestIds.includes(source.requestId)) fail('答复必须包含本次来源输入。', 400);
    for (const id of packet.requestIds) if (!belongs(await store.byRequest(root.sessionId, id))) fail('不能合并其他人、其他运行或未确认接收的输入。');
    const fingerprint = canonicalJson(packet);
    const previous = root.inflightTrialReplies?.find(r => r.replyId === packet.replyId);
    if (previous && previous.fingerprint !== fingerprint) fail('replyId 已用于不同内容；请保留原回执。', 409);
    const messageId = `input-trial:${createHash('sha256').update(root.runId + ':' + packet.replyId).digest('hex')}`;
    const parts = buildReplyDeliveries(planFor(source), { text: packet.text }, {
      running: true, surfaceKind: 'reply', messageReplyPolicy: source.options.messageReplyPolicy });
    if (!parts.length) fail('当前来源不支持试用中的单独答复。', 409);
    const updated = await store.mutate(root.key, current => {
      const existing = current.inflightTrialReplies?.find(r => r.replyId === packet.replyId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) fail('replyId 已用于不同内容。', 409);
        return current;
      }
      if (!live(current) || current.options?.suppressSourceDelivery || current.routingHandoff) fail('运行已结束、停止或转移；未投递答复。', 409);
      return { ...current,
        inflightTrialReplies: [...(current.inflightTrialReplies || []), { ...packet, fingerprint, messageId, createdAt: new Date().toISOString() }],
        streamedSurfaceMessageIds: [...(current.streamedSurfaceMessageIds || []), messageId],
        deliveries: appendDeliveries(current, parts.map(part => ({ ...part, surfaceKind: 'reply',
          publicationRequestId: source.requestId, inflightTrialReplyId: packet.replyId }))) };
    });
    // Reserve the native-publication marker in the SAME commit as the outbox.
    // A retry repairs a missing history mirror without publishing another reply.
    if (!events.some(event => event.providerMessageId === messageId)) await append(root.sessionId, {
      type: 'message', role: 'assistant', phase: 'commentary', runId: root.runId, responseId: root.responseId,
      providerMessageId: messageId, content: `<reply>${packet.text}</reply>`,
      inflightTrialReplyId: packet.replyId, publicationRequestIds: packet.requestIds });
    return { replyId: packet.replyId, duplicate: Boolean(previous),
      deliveries: updated.deliveries.filter(d => d.inflightTrialReplyId === packet.replyId)
        .map(d => ({ id: d.id, state: d.state, externalId: d.externalId })) };
  });
}
const execute = createInflightTrialTools();
export async function handleInflightTrialRoutes({ req, res, pathname, authSession, writeJson }) {
  if (!pathname.startsWith('/api/input-trial/')) return false;
  try {
    if (req.method !== 'POST') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
    const input = JSON.parse(await readBody(req, 65536) || '{}');
    writeJson(res, 200, await execute(pathname.slice('/api/input-trial/'.length), input, authSession));
  } catch (error) { writeJson(res, error.status || 400, { error: error.message }); }
  return true;
}
