import { artifactKind, usageEvents, usageKey } from './usage-events.mjs';
import { nativeCapability } from './usage-capabilities.mjs';

const record = (event, context) => { void usageEvents.record(event, context); };
function actor(options = {}) {
  if (options.internalOperation) return { actorKind: 'system', surface: 'runtime' };
  if (options.automationTitle || options.triggerId || options.scheduleId) return { actorKind: 'automation', surface: 'automation' };
  return { actorKind: options.usageActorKind || 'agent', surface: options.usageSurface || 'agent' };
}
function conversationKey(source = {}) {
  if (source?.connector !== 'feishu') return '';
  const target = source.target || source;
  const chat = target.chatId || source.chatId;
  if (!chat) return '';
  return usageKey(JSON.stringify([source.sourceRouteId || 'default', chat,
    target.rootId || source.rootId || target.topicId || source.topicId || target.threadId || source.threadId || 'main']));
}
export function observeRequestUsage(request, { accepted = false, previous } = {}) {
  if (!request) return;
  const options = request.options || {}, attribution = actor(options);
  const base = { sessionId: request.sessionId, requestId: request.requestId, runId: request.runId, automationId: options.triggerId || options.scheduleId, ...attribution };
  const context = { personId: attribution.actorKind === 'human' ? options.usagePersonId : '' };
  if (accepted && !options.deliveryOnly && !options.internalOperation && options.recordUserMessage !== false) {
    record({ ...base, eventId: usageKey(`input:${request.key}`), event: 'message_submitted',
      timestamp: Date.parse(request.acceptedAt), conversationKey: conversationKey(options.sourceContext),
      kind: options.nativeQuestionId ? 'question_answer' : 'message' }, context);
    if (attribution.actorKind === 'human') for (const material of request.images || []) {
      const objectId = usageKey(material.savedPath || material.filename || material.assetId || '');
      record({ ...base, eventId: usageKey(`material:${request.key}:${objectId}`), event: 'material_submitted',
        objectId, kind: artifactKind(material.mimeType), timestamp: Date.parse(request.acceptedAt) }, context);
    }
  }
  if (attribution.actorKind === 'human' && request.nativeDispatchRunId && !previous?.nativeDispatchRunId) {
    record({ ...base, eventId: usageKey(`intervention:${request.key}`), event: 'intervention', state: 'applied',
      operation: options.nativeQuestionId ? 'question_answer' : 'follow_up', runId: request.nativeDispatchRunId,
      timestamp: Date.parse(request.settledAt || request.acceptedAt) }, context);
  }
  // Native follow-up/answer requests can use an existing Run. Settling them
  // must never manufacture extra completed Runs in the usage counts.
  if (request.result && !options.deliveryOnly && (!previous || previous.resultState !== request.result.state || previous.settledAt !== request.settledAt)) record({ ...base, actorKind: 'system', event: 'request_state', state: request.result.state,
    runId: request.nativeDispatchRunId || request.runId,
    eventId: usageKey(`request-result:${request.key}:${request.result.state}`), timestamp: Date.parse(request.settledAt) });
  for (const delivery of request.deliveries || []) {
    if (!['delivered', 'delivery_failed', 'unknown', 'cancelled'].includes(delivery.state)) continue;
    const prior = previous?.deliveries?.find(part => part.id === delivery.id);
    if (prior && prior.state === delivery.state && prior.attempts === delivery.attempts) continue;
    record({ ...base, actorKind: 'system', surface: delivery.connector === 'feishu' ? 'feishu' : 'runtime',
      eventId: usageKey(`delivery:${delivery.id}:${delivery.state}:${delivery.attempts}`), event: 'delivery_state',
      objectId: delivery.id, state: delivery.state, kind: delivery.kind,
      attempts: delivery.attempts,
      timestamp: Date.parse(delivery.deliveredAt || delivery.updatedAt || request.settledAt || request.acceptedAt) });
  }
}
export function observeRunUsage(run) {
  if (!run) return;
  record({ eventId: usageKey(`run:${run.id}:${run.state}`), event: 'run_state', state: run.state,
    sessionId: run.sessionId, requestId: run.requestId, runId: run.id, actorKind: 'agent', surface: 'runtime',
    timestamp: Date.parse(run.completedAt || run.startedAt || run.createdAt), tool: run.tool });
}
export function observeHistoryUsage(sessionId, event) {
  const base = { sessionId, requestId: event.requestId, runId: event.runId || event.resultRunId, historySeq: event.seq,
    actorKind: 'agent', surface: 'runtime', timestamp: event.timestamp };
  const eventId = usageKey(`history:${sessionId}:${event.seq}`);
  if (event.type === 'tool_use' || event.type === 'tool_result') {
    record({ ...base, eventId, event: event.type === 'tool_use' ? 'tool_started' : 'tool_finished',
      tool: event.toolName, toolCallId: event.toolCallId,
      state: event.type === 'tool_use' ? 'started' : event.exitCode === 0 ? 'succeeded'
        : (Number.isInteger(event.exitCode) && event.exitCode !== 0) || event.isError === true ? 'failed' : 'unknown' });
    const feature = nativeCapability(event.toolName);
    if (feature && event.toolCallId) record({ ...base, eventId: usageKey(`capability:${sessionId}:${event.seq}`),
      event: 'capability_state', feature, operation: 'invoke', origin: 'native_tool',
      operationId: usageKey(`tool:${sessionId}:${event.toolCallId}`),
      state: event.type === 'tool_use' ? 'started' : event.exitCode === 0 ? 'completed'
        : event.isError === true || (Number.isInteger(event.exitCode) && event.exitCode !== 0) ? 'failed' : 'unknown' });
  }
  if (event.type === 'context_operation' && ['read_memory', 'write_memory'].includes(event.operation)) {
    record({ ...base, eventId, event: 'knowledge_state', operation: event.operation, state: event.phase });
  }
  if (event.messageKind === 'user_question' && event.questionId) record({ ...base, eventId, event: 'question_state',
    questionId: event.questionId, state: event.questionState, origin: event.answerOrigin, deadline: event.questionDeadline });
  if (event.type === 'artifact' && event.source === 'provider_session') record({ ...base, eventId, event: 'artifact_generated',
    objectId: usageKey(event.localPath || eventId), kind: artifactKind(event.mimeType), operation: 'create' });
  if (event.type === 'message' && event.role === 'assistant') {
    for (const attachment of event.attachments || []) {
      const objectId = attachment.assetId || (attachment.filename ? usageKey(attachment.filename) : '');
      if (!objectId) continue;
      record({ ...base, eventId: usageKey(`attached:${sessionId}:${event.seq}:${objectId}`), event: 'artifact_attached',
        objectId, kind: artifactKind(attachment.mimeType), sizeBytes: attachment.sizeBytes, operation: 'attach' });
    }
  }
}
