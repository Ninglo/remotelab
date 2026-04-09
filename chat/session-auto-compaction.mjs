import { randomBytes } from 'crypto';
import {
  getContextHead,
  getHistorySnapshot,
  loadHistory,
  setContextHead,
} from './history.mjs';
import { contextOperationEvent, messageEvent, statusEvent } from './normalizer.mjs';
import { buildTemplateFreshnessNotice } from './session-continuation.mjs';
import { formatAttachmentContextLine, getMessageAttachments } from './attachment-utils.mjs';
import { updateRun } from './runs.mjs';
import { readLatestCodexSessionMetrics } from './codex-session-metrics.mjs';
import { clipCompactionSection } from './session-context-compaction.mjs';
import { extractTaggedBlock } from './session-text-parsing.mjs';
import { findLatestAssistantMessageForRun } from './session-assistant-followups.mjs';

export const INTERNAL_SESSION_ROLE_CONTEXT_COMPACTOR = 'context_compactor';

const AUTO_COMPACT_MARKER_TEXT = 'Older messages above this marker are no longer in the model\'s current context. They remain visible in the transcript, but only the compressed handoff and newer messages below are loaded for continued work.';
const CONTEXT_COMPACTOR_SYSTEM_PROMPT = [
  'You are RemoteLab\'s hidden context compactor for a user-facing session.',
  'Your job is to condense older session context into a compact continuation package.',
  'Preserve the task objective, accepted decisions, constraints, completed work, current state, open questions, and next steps.',
  'Do not include raw tool dumps unless a tiny excerpt is essential.',
  'Be explicit about what is no longer in the current context and what the next worker should rely on.',
].join('\n');
const DEFAULT_AUTO_COMPACT_CONTEXT_WINDOW_PERCENT = 100;

function parsePositiveIntOrInfinity(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return null;
  if (/^(inf|infinity)$/i.test(trimmed)) return Number.POSITIVE_INFINITY;
  const parsed = parseInt(trimmed, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function getConfiguredAutoCompactContextTokens() {
  return parsePositiveIntOrInfinity(process.env.REMOTELAB_CURRENT_CONTEXT_COMPACT_TOKENS);
}

function getRunCurrentContextTokens(run) {
  return Number.isInteger(run?.contextInputTokens) && run.contextInputTokens > 0
    ? run.contextInputTokens
    : null;
}

function getRunContextWindowTokens(run) {
  return Number.isInteger(run?.contextWindowTokens) && run.contextWindowTokens > 0
    ? run.contextWindowTokens
    : null;
}

function getAutoCompactContextTokens(run) {
  const configured = getConfiguredAutoCompactContextTokens();
  if (configured !== null) {
    return configured;
  }
  const contextWindowTokens = getRunContextWindowTokens(run);
  if (!Number.isInteger(contextWindowTokens)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(
    1,
    Math.floor((contextWindowTokens * DEFAULT_AUTO_COMPACT_CONTEXT_WINDOW_PERCENT) / 100),
  );
}

export function shouldAutoCompactRun(run) {
  const contextTokens = getRunCurrentContextTokens(run);
  const autoCompactTokens = getAutoCompactContextTokens(run);
  return Number.isInteger(contextTokens)
    && Number.isFinite(autoCompactTokens)
    && contextTokens > autoCompactTokens;
}

async function refreshCodexContextMetrics(run) {
  if (!run?.id || !run?.codexThreadId) return null;
  const metrics = await readLatestCodexSessionMetrics(run.codexThreadId);
  if (!Number.isInteger(metrics?.contextTokens)) return null;

  await updateRun(run.id, (current) => ({
    ...current,
    contextInputTokens: metrics.contextTokens,
    ...(Number.isInteger(metrics.contextWindowTokens)
      ? { contextWindowTokens: metrics.contextWindowTokens }
      : {}),
  }));

  return metrics;
}

function getAutoCompactStatusText(run) {
  const configured = getConfiguredAutoCompactContextTokens();
  const contextTokens = getRunCurrentContextTokens(run);
  const contextWindowTokens = getRunContextWindowTokens(run);
  if (configured === null && Number.isInteger(contextTokens) && Number.isInteger(contextWindowTokens)) {
    const percent = ((contextTokens / contextWindowTokens) * 100).toFixed(1);
    return `Current context exceeded the model window (${contextTokens.toLocaleString()} / ${contextWindowTokens.toLocaleString()}, ${percent}%) — compacting conversation…`;
  }
  const autoCompactTokens = getAutoCompactContextTokens(run);
  if (Number.isFinite(autoCompactTokens)) {
    return `Current context exceeded ${autoCompactTokens.toLocaleString()} tokens — compacting conversation…`;
  }
  return 'Current context overflowed — compacting conversation…';
}

function trimCompactionReason(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) return '';
  return normalized.replace(/[.。…\s]+$/u, '');
}

function getCompactionTriggerReason(run, { automatic = false } = {}) {
  if (!automatic) return 'Manual context compaction was requested';
  return trimCompactionReason(getAutoCompactStatusText(run));
}

function buildQueuedCompactionOperation(sessionId, compactorSessionId, compactionSource, run, { automatic = false } = {}) {
  return contextOperationEvent({
    operation: 'compact_context',
    phase: 'queued',
    trigger: automatic ? 'automatic' : 'manual',
    title: automatic ? 'Auto Compress queued' : 'Context compaction queued',
    summary: 'RemoteLab started condensing older context into a continuation handoff.',
    reason: getCompactionTriggerReason(run, { automatic }),
    targetSessionId: sessionId,
    workerSessionId: compactorSessionId,
    compactedThroughSeq: Number.isInteger(compactionSource?.targetSeq) ? compactionSource.targetSeq : 0,
    hadExistingSummary: !!String(compactionSource?.existingSummary || '').trim(),
  });
}

function buildFailedCompactionOperation(sessionId, errorMessage, { automatic = false, workerSessionId = '' } = {}) {
  return contextOperationEvent({
    operation: 'compact_context',
    phase: 'failed',
    trigger: automatic ? 'automatic' : 'manual',
    title: automatic ? 'Auto Compress failed' : 'Context compaction failed',
    summary: 'RemoteLab could not replace older context with a continuation handoff.',
    reason: errorMessage,
    targetSessionId: sessionId,
    ...(workerSessionId ? { workerSessionId } : {}),
  });
}

function buildAppliedCompactionOperation(targetSessionId, run, manifest, summary) {
  const automatic = manifest?.compactionReason === 'automatic';
  return contextOperationEvent({
    operation: 'compact_context',
    phase: 'applied',
    trigger: automatic ? 'automatic' : 'manual',
    title: automatic ? 'Current context compacted' : 'Context compaction applied',
    summary: 'Older context was replaced with a continuation summary and handoff.',
    reason: getCompactionTriggerReason(run, { automatic }),
    targetSessionId,
    workerSessionId: run?.sessionId || '',
    compactedThroughSeq: Number.isInteger(manifest?.compactionSourceSeq) ? manifest.compactionSourceSeq : 0,
    summaryChars: typeof summary === 'string' ? summary.length : 0,
  });
}

function parseCompactionWorkerOutput(content) {
  return {
    summary: extractTaggedBlock(content, 'summary'),
    handoff: extractTaggedBlock(content, 'handoff'),
  };
}

function buildFallbackCompactionHandoff(summary, toolIndex) {
  const parts = [
    '# Auto Compress',
    '',
    '## Kept in current context',
    '- RemoteLab carried forward a compressed continuation summary for the task.',
  ];

  const trimmedSummary = clipCompactionSection(summary, 3000);
  if (trimmedSummary) {
    parts.push('', trimmedSummary);
  }

  parts.push('', '## Left out of current context', '- Older messages above the marker are no longer loaded into the model\'s current context.');
  if (toolIndex) {
    parts.push('- Earlier tool activity remains in session history and is summarized as compact retrieval hints.');
  }
  parts.push('', '## Continue from here', '- Use the carried-forward summary plus the new messages below this marker.');
  return parts.join('\n');
}

function buildContextCompactionPrompt({ session, existingSummary, conversationBody, toolIndex, automatic = false }) {
  const appInstructions = clipCompactionSection(session?.systemPrompt || '', 6000);
  const priorSummary = clipCompactionSection(existingSummary || '', 12000);
  const conversationSlice = clipCompactionSection(conversationBody || '', 18000);
  const toolActivity = clipCompactionSection(toolIndex || '', 10000);

  return [
    'Please compress this entire session into a continuation summary for the same AI worker.',
    '',
    'You are operating inside RemoteLab\'s hidden compaction worker for a parent session.',
    `Compaction trigger: ${automatic ? 'automatic auto-compress' : 'manual compact request'}`,
    '',
    'Goal:',
    '- Replace older context with a fresh continuation package.',
    '- Preserve only what the next worker turn truly needs.',
    '- Treat older tool activity as retrievable hints, not as currently loaded prompt material.',
    '',
    'Rules:',
    '- Use only the supplied session material; do not rely on prior thread state.',
    '- Do not call tools unless absolutely necessary.',
    '- Do not include full raw tool output.',
    '- Mark uncertainty clearly.',
    '- The user-visible handoff must explicitly say that older messages above the marker are no longer in the current context.',
    '',
    'Return exactly two tagged blocks:',
    '<summary>',
    'Dense operational continuation state for the next worker turn.',
    'Include the main objective, confirmed constraints, completed work, current code/system state, open questions, next steps, and critical references.',
    '</summary>',
    '',
    '<handoff>',
    '# Auto Compress',
    '## Kept in current context',
    '- ...',
    '## Left out of current context',
    '- ...',
    '## Continue from here',
    '- ...',
    '</handoff>',
    '',
    'Parent session app instructions:',
    appInstructions || '[none]',
    '',
    'Previously carried summary:',
    priorSummary || '[none]',
    '',
    'New conversation slice since the last compaction:',
    conversationSlice || '[no new conversation messages]',
    '',
    'Earlier tool activity index:',
    toolActivity || '[no earlier tool activity recorded]',
  ].join('\n');
}

function normalizeCompactionText(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim();
}

function clipCompactionEventText(value, maxChars = 4000) {
  const text = normalizeCompactionText(value);
  if (!text) return '';
  if (text.length <= maxChars) return text;
  const headChars = Math.max(1, Math.floor(maxChars * 0.6));
  const tailChars = Math.max(1, maxChars - headChars);
  return `${text.slice(0, headChars).trimEnd()}\n[... truncated by RemoteLab ...]\n${text.slice(-tailChars).trimStart()}`;
}

function formatCompactionAttachments(images) {
  return formatAttachmentContextLine(images);
}

function formatCompactionMessage(event) {
  const label = event.role === 'user' ? 'User' : 'Assistant';
  const parts = [];
  const imageLine = formatCompactionAttachments(getMessageAttachments(event));
  if (imageLine) parts.push(imageLine);
  const content = clipCompactionEventText(event.content);
  if (content) parts.push(content);
  if (parts.length === 0) return '';
  return `[${label}]\n${parts.join('\n')}`;
}

function formatCompactionTemplateContext(event) {
  const content = normalizeCompactionText(event.content);
  if (!content) return '';
  const name = normalizeCompactionText(event.templateName) || 'template';
  const freshnessNotice = buildTemplateFreshnessNotice(event);
  return freshnessNotice
    ? `[Applied template context: ${name}]\n${freshnessNotice}\n\n${content}`
    : `[Applied template context: ${name}]\n${content}`;
}

function formatCompactionStatus(event) {
  const content = clipCompactionEventText(event.content, 1000);
  if (!content) return '';
  if (!/^error:/i.test(content) && !/interrupted/i.test(content)) return '';
  return `[System status]\n${content}`;
}

function prepareConversationOnlyContinuationBody(events) {
  const segments = (events || [])
    .map((event) => {
      if (!event || !event.type) return '';
      if (event.type === 'message') return formatCompactionMessage(event);
      if (event.type === 'template_context') return formatCompactionTemplateContext(event);
      if (event.type === 'status') return formatCompactionStatus(event);
      return '';
    })
    .filter(Boolean);

  if (segments.length === 0) return '';
  return clipCompactionSection(segments.join('\n\n'), 24000);
}

function buildToolActivityIndex(events) {
  const toolCounts = new Map();
  const recentCommands = [];
  const touchedFiles = [];
  const notableFailures = [];

  const pushRecentUnique = (entries, key, value, maxEntries) => {
    if (!key || !value) return;
    const existingIndex = entries.findIndex((entry) => entry.key === key);
    if (existingIndex !== -1) {
      entries.splice(existingIndex, 1);
    }
    entries.push({ key, value });
    if (entries.length > maxEntries) {
      entries.shift();
    }
  };

  for (const event of events || []) {
    if (!event || !event.type) continue;
    if (event.type === 'tool_use') {
      const toolName = normalizeCompactionText(event.toolName) || 'tool';
      toolCounts.set(toolName, (toolCounts.get(toolName) || 0) + 1);
      const toolInput = clipCompactionEventText(event.toolInput, 240);
      if (toolInput) {
        pushRecentUnique(recentCommands, `${toolName}:${toolInput}`, `- ${toolName}: ${toolInput.replace(/\n/g, ' ↵ ')}`, 8);
      }
      continue;
    }
    if (event.type === 'file_change') {
      const filePath = normalizeCompactionText(event.filePath);
      if (!filePath) continue;
      const changeType = normalizeCompactionText(event.changeType) || 'updated';
      pushRecentUnique(touchedFiles, `${changeType}:${filePath}`, `- ${filePath} (${changeType})`, 12);
      continue;
    }
    if (event.type === 'tool_result') {
      const exitCode = event.exitCode;
      if (exitCode === undefined || exitCode === 0) continue;
      const toolName = normalizeCompactionText(event.toolName) || 'tool';
      const output = clipCompactionEventText(event.output, 320);
      pushRecentUnique(notableFailures, `${toolName}:${exitCode}:${output}`, `- ${toolName} exit ${exitCode}: ${output.replace(/\n/g, ' ↵ ')}`, 6);
    }
  }

  const toolSummary = [...toolCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([toolName, count]) => `${toolName} ×${count}`)
    .join(', ');

  const lines = [];
  if (toolSummary) lines.push(`Tools used: ${toolSummary}`);
  if (recentCommands.length > 0) {
    lines.push('Recent tool calls:');
    lines.push(...recentCommands.map((entry) => entry.value));
  }
  if (touchedFiles.length > 0) {
    lines.push('Touched files:');
    lines.push(...touchedFiles.map((entry) => entry.value));
  }
  if (notableFailures.length > 0) {
    lines.push('Notable tool failures:');
    lines.push(...notableFailures.map((entry) => entry.value));
  }

  if (lines.length === 0) return '';
  return clipCompactionSection(lines.join('\n'), 12000);
}

function createContextBarrierEvent(content, extra = {}) {
  return {
    type: 'context_barrier',
    role: 'system',
    id: `evt_${randomBytes(8).toString('hex')}`,
    timestamp: Date.now(),
    content,
    ...extra,
  };
}

async function buildCompactionSourcePayload(sessionId, { uptoSeq = 0 } = {}) {
  const [contextHead, history] = await Promise.all([
    getContextHead(sessionId),
    loadHistory(sessionId, { includeBodies: true }),
  ]);
  const targetSeq = uptoSeq > 0 ? uptoSeq : (history.at(-1)?.seq || 0);
  const boundedHistory = history.filter((event) => (event?.seq || 0) <= targetSeq);
  const activeFromSeq = Number.isInteger(contextHead?.activeFromSeq) ? contextHead.activeFromSeq : 0;
  const sliceEvents = boundedHistory.filter((event) => (event?.seq || 0) > activeFromSeq);
  const existingSummary = typeof contextHead?.summary === 'string' ? contextHead.summary.trim() : '';
  const conversationBody = prepareConversationOnlyContinuationBody(sliceEvents);
  const toolIndex = buildToolActivityIndex(boundedHistory);

  if (!existingSummary && !conversationBody && !toolIndex) {
    return null;
  }

  return {
    targetSeq,
    existingSummary,
    conversationBody,
    toolIndex,
  };
}

async function ensureContextCompactorSession(sourceSessionId, session, run, services = {}) {
  const existingId = typeof session?.compactionSessionId === 'string' ? session.compactionSessionId.trim() : '';
  if (existingId) {
    const existing = await services.getSession(existingId);
    if (existing) {
      if ((run?.tool || session.tool) && existing.tool !== (run?.tool || session.tool)) {
        await services.mutateSessionMeta(existing.id, (draft) => {
          draft.tool = run?.tool || session.tool;
          draft.updatedAt = services.nowIso();
          return true;
        });
      }
      return existing;
    }
  }

  const metas = await services.loadSessionsMeta();
  const linked = metas.find((meta) => meta.compactsSessionId === sourceSessionId && services.isContextCompactorSession(meta));
  if (linked) {
    await services.mutateSessionMeta(sourceSessionId, (draft) => {
      if (draft.compactionSessionId === linked.id) return false;
      draft.compactionSessionId = linked.id;
      draft.updatedAt = services.nowIso();
      return true;
    });
    return services.enrichSessionMeta(linked);
  }

  const created = await services.createSession(session.folder, run?.tool || session.tool, `auto-compress - ${session.name || 'session'}`, {
    sourceId: session.sourceId || '',
    sourceName: session.sourceName || '',
    systemPrompt: CONTEXT_COMPACTOR_SYSTEM_PROMPT,
    internalRole: INTERNAL_SESSION_ROLE_CONTEXT_COMPACTOR,
    compactsSessionId: sourceSessionId,
    rootSessionId: session.rootSessionId || session.id,
  });
  if (!created) return null;

  await services.mutateSessionMeta(sourceSessionId, (draft) => {
    if (draft.compactionSessionId === created.id) return false;
    draft.compactionSessionId = created.id;
    draft.updatedAt = services.nowIso();
    return true;
  });

  return created;
}

export async function queueContextCompaction(sessionId, session, run, { automatic = false } = {}, services = {}) {
  const runtimeState = services.ensureSessionRuntimeState(sessionId);
  if (runtimeState.pendingCompact) return false;

  const snapshot = await getHistorySnapshot(sessionId);
  const compactionSource = await buildCompactionSourcePayload(sessionId, {
    uptoSeq: snapshot.latestSeq,
  });
  if (!compactionSource) return false;

  const compactorSession = await ensureContextCompactorSession(sessionId, session, run, services);
  if (!compactorSession) return false;

  runtimeState.pendingCompact = true;

  const statusText = automatic
    ? getAutoCompactStatusText(run)
    : 'Auto Compress is condensing older context…';
  const compactQueuedEvent = statusEvent(statusText);
  await services.appendEvent(sessionId, compactQueuedEvent);
  await services.appendEvent(sessionId, buildQueuedCompactionOperation(
    sessionId,
    compactorSession.id,
    compactionSource,
    run,
    { automatic },
  ));
  services.broadcastSessionInvalidation(sessionId);

  try {
    await services.sendMessage(compactorSession.id, buildContextCompactionPrompt({
      session,
      existingSummary: compactionSource.existingSummary,
      conversationBody: compactionSource.conversationBody,
      toolIndex: compactionSource.toolIndex,
      automatic,
    }), [], {
      tool: run?.tool || session.tool,
      model: run?.model || undefined,
      effort: run?.effort || undefined,
      thinking: false,
      recordUserMessage: false,
      queueIfBusy: false,
      freshThread: true,
      skipSessionContinuation: true,
      internalOperation: 'context_compaction_worker',
      compactionTargetSessionId: sessionId,
      compactionSourceSeq: compactionSource.targetSeq,
      compactionToolIndex: compactionSource.toolIndex,
      compactionReason: automatic ? 'automatic' : 'manual',
    });
    return true;
  } catch (error) {
    runtimeState.pendingCompact = false;
    const failure = statusEvent(`error: failed to compact context: ${error.message}`);
    await services.appendEvent(sessionId, failure);
    await services.appendEvent(sessionId, buildFailedCompactionOperation(sessionId, error.message, {
      automatic,
      workerSessionId: compactorSession.id,
    }));
    services.broadcastSessionInvalidation(sessionId);
    return false;
  }
}

export async function maybeAutoCompact(sessionId, session, run, manifest, services = {}) {
  if (!session || !run) return false;
  if (manifest?.internalOperation && manifest.internalOperation !== 'reply_self_repair') return false;
  if (services.getSessionQueueCount(session) > 0) return false;
  let effectiveRun = run;
  let contextTokens = getRunCurrentContextTokens(run);
  let autoCompactTokens = getAutoCompactContextTokens(run);
  if (!Number.isInteger(contextTokens) || !Number.isFinite(autoCompactTokens)) {
    const refreshed = await refreshCodexContextMetrics(run);
    if (refreshed) {
      effectiveRun = {
        ...run,
        contextInputTokens: refreshed.contextTokens,
        ...(Number.isInteger(refreshed.contextWindowTokens)
          ? { contextWindowTokens: refreshed.contextWindowTokens }
          : {}),
      };
      contextTokens = refreshed.contextTokens;
      autoCompactTokens = getAutoCompactContextTokens(effectiveRun);
    }
  }
  if (!Number.isInteger(contextTokens) || !Number.isFinite(autoCompactTokens)) return false;
  if (!shouldAutoCompactRun({
    ...effectiveRun,
    contextInputTokens: contextTokens,
  })) return false;
  return queueContextCompaction(sessionId, session, effectiveRun, { automatic: true }, services);
}

export async function applyCompactionWorkerResult(targetSessionId, run, manifest, services = {}) {
  const workerEvent = await findLatestAssistantMessageForRun(run.sessionId, run.id);
  const parsed = parseCompactionWorkerOutput(workerEvent?.content || '');
  const summary = parsed.summary;
  if (!summary) {
    await services.appendEvent(targetSessionId, statusEvent('error: failed to apply auto compress: compaction worker returned no <summary> block'));
    await services.appendEvent(targetSessionId, buildFailedCompactionOperation(
      targetSessionId,
      'Compaction worker returned no <summary> block',
      {
        automatic: manifest?.compactionReason === 'automatic',
        workerSessionId: run?.sessionId || '',
      },
    ));
    return false;
  }

  const barrierEvent = await services.appendEvent(targetSessionId, createContextBarrierEvent(AUTO_COMPACT_MARKER_TEXT, {
    automatic: manifest?.compactionReason === 'automatic',
    compactionSessionId: run.sessionId,
  }));
  const handoffContent = parsed.handoff || buildFallbackCompactionHandoff(summary, manifest?.compactionToolIndex || '');
  const handoffEvent = await services.appendEvent(targetSessionId, messageEvent('assistant', handoffContent, undefined, {
    source: 'context_compaction_handoff',
    compactionRunId: run.id,
  }));
  await services.appendEvent(targetSessionId, buildAppliedCompactionOperation(targetSessionId, run, manifest, summary));
  const compactEvent = await services.appendEvent(targetSessionId, statusEvent('Auto Compress finished — continue from the handoff below'));

  await setContextHead(targetSessionId, {
    mode: 'summary',
    summary,
    toolIndex: manifest?.compactionToolIndex || '',
    activeFromSeq: compactEvent.seq,
    compactedThroughSeq: Number.isInteger(manifest?.compactionSourceSeq) ? manifest.compactionSourceSeq : compactEvent.seq,
    inputTokens: run.contextInputTokens || null,
    updatedAt: services.nowIso(),
    source: 'context_compaction',
    barrierSeq: barrierEvent.seq,
    handoffSeq: handoffEvent.seq,
    compactionSessionId: run.sessionId,
  });

  await services.clearPersistedResumeIds(targetSessionId);
  return true;
}
