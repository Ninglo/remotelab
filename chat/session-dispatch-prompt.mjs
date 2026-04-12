/**
 * Prompt construction for the pre-execution session continuation planner.
 *
 * The planner decides how the incoming user message should continue:
 * - continue in the current session
 * - fork into one or more related branch sessions
 * - start one or more fresh sessions with minimal forwarded context
 */

function clipText(text, maxChars = 500) {
  const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars).trimEnd()}…`;
}

function clipTranscript(text, maxChars = 18000) {
  const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  const headChars = Math.max(1, Math.floor(maxChars * 0.65));
  const tailChars = Math.max(1, maxChars - headChars);
  return `${normalized.slice(0, headChars).trimEnd()}\n[... transcript clipped ...]\n${normalized.slice(-tailChars).trimStart()}`;
}

function formatSessionSummary(session) {
  if (!session?.id) return '';
  const parts = [`- id: ${session.id}`];
  if (session.name) parts.push(`  name: ${session.name}`);
  if (session.group) parts.push(`  group: ${session.group}`);
  if (session.description) parts.push(`  description: ${clipText(session.description, 160)}`);
  if (session.templateId) {
    parts.push(`  agent: ${session.templateName || session.templateId}`);
  }
  if (session.sourceId && session.sourceId !== 'chat') {
    parts.push(`  source: ${session.sourceName || session.sourceId}`);
  }
  return parts.join('\n');
}

export function buildContinuationPlannerPrompt({
  currentSession,
  currentTranscript = '',
  message,
}) {
  const currentSummary = formatSessionSummary(currentSession);
  const messageText = clipText(message, 2500);
  const transcriptText = clipTranscript(currentTranscript, 20000);

  return [
    'You are RemoteLab\'s hidden pre-turn continuation planner.',
    'Your job is to decide how the new user input should continue relative to the CURRENT session.',
    'You are not choosing between arbitrary historical sessions. You are deciding continuation mode.',
    '',
    'Allowed continuation modes per destination:',
    '- "continue": the message belongs in the current session and should keep flowing there.',
    '- "fork": the message is strongly related to the current session but should branch into a new child session that inherits rich parent context.',
    '- "fresh": the message should start a new session/workstream with only minimal forwarded context from the current session.',
    '',
    'Rules:',
    '- Default to a SINGLE "continue" destination when uncertain. False splitting is worse than no splitting.',
    '- The CURRENT SESSION transcript is the primary source of truth.',
    '- A simple one-off ask that can be answered in this turn should usually stay as "continue", even if it is not tightly related to the prior topic.',
    '- Topic shift alone is not enough for "fresh". Use "fresh" only when the new input is clearly a separate workstream that is complex enough, durable enough, or distinct enough to deserve its own session.',
    '- In loose personal-assistant style chats, prefer "continue" for quick factual questions, reminders, weather checks, and other self-contained utility asks.',
    '- Use "fork" only when the new input clearly depends on the current session\'s context but deserves a separate branch after this point.',
    '- Use "fresh" only when the new input should not continue as part of the current session\'s main thread and should become its own durable work thread.',
    '- Multiple destinations are allowed only when the user input clearly contains multiple downstream workstreams that should proceed separately.',
    '- Multiple destinations should usually imply genuinely separate tasks or a clearly decomposable request, not just a casual multi-part sentence.',
    '- Never create multiple destinations just because the user mentioned several related details in one sentence.',
    '- A destination with mode "continue" always owns the current session. A destination with mode "fork" or "fresh" always creates a new session.',
    '- For "fork", prefer "full_parent_context". For "fresh", prefer "minimal_forwarded_context".',
    '- For "continue", use "reuse_current_context".',
    '- Keep reasoning flexible, but return a stable machine-readable result.',
    '',
    'Current session:',
    currentSummary || '(new/empty session)',
    '',
    transcriptText ? `Current session transcript:\n${transcriptText}` : 'Current session transcript: (empty)',
    '',
    'Incoming user message:',
    messageText || '(empty)',
    '',
    'Return exactly one JSON object inside a <hide> block with this shape:',
    '{',
    '  "confidence": number 0-1,',
    '  "reasoning": "short explanation in the user\'s language",',
    '  "userVisibleSummary": "short explanation suitable for UI/logs in the user\'s language",',
    '  "destinations": [',
    '    {',
    '      "mode": "continue" | "fork" | "fresh",',
    '      "inheritanceProfile": "reuse_current_context" | "full_parent_context" | "minimal_forwarded_context",',
    '      "reasoning": "short destination-specific explanation in the user\'s language",',
    '      "scopeFraming": "short scope framing for the destination session",',
    '      "deliveryText": "the user-facing text this destination should process; can be the original or a scoped rewrite",',
    '      "forwardedContext": "optional short forwarded context summary for fresh/fork child setup",',
    '      "titleHint": "optional short session title hint"',
    '    }',
    '  ]',
    '}',
    '',
    'Requirements:',
    '- Always return at least one destination.',
    '- If there is only one destination and it belongs in the current session, use mode "continue".',
    '- If you return multiple destinations, each destination must represent a genuinely different downstream workstream.',
    '- Do not output any text outside the <hide> block.',
  ].join('\n');
}

function normalizeMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'fork') return 'fork';
  if (normalized === 'fresh') return 'fresh';
  return 'continue';
}

function normalizeInheritanceProfile(value, mode) {
  const normalized = String(
    value?.type
    || value?.profile
    || value
    || '',
  ).trim().toLowerCase();

  if (normalized === 'full_parent_context') return 'full_parent_context';
  if (normalized === 'minimal_forwarded_context') return 'minimal_forwarded_context';
  if (normalized === 'reuse_current_context') return 'reuse_current_context';

  if (mode === 'fork') return 'full_parent_context';
  if (mode === 'fresh') return 'minimal_forwarded_context';
  return 'reuse_current_context';
}

function normalizeShortText(value, maxChars = 300) {
  return String(value || '').replace(/\r\n/g, '\n').trim().slice(0, maxChars);
}

export function parseContinuationPlan(content) {
  const text = String(content || '').trim();
  const hideMatch = text.match(/<hide>([\s\S]*?)<\/hide>/i);
  const jsonSource = hideMatch ? hideMatch[1].trim() : text;
  const jsonMatch = jsonSource.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return {
      confidence: 0,
      reasoning: 'parse failure',
      userVisibleSummary: '',
      destinations: [],
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const confidence = typeof parsed.confidence === 'number'
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0;
    const rawDestinations = Array.isArray(parsed.destinations) ? parsed.destinations.slice(0, 3) : [];
    const destinations = rawDestinations
      .map((destination, index) => {
        const mode = normalizeMode(destination?.mode);
        return {
          destinationId: `dest_${index + 1}`,
          mode,
          inheritanceProfile: normalizeInheritanceProfile(destination?.inheritanceProfile, mode),
          reasoning: normalizeShortText(destination?.reasoning, 220),
          scopeFraming: normalizeShortText(destination?.scopeFraming, 320),
          deliveryText: normalizeShortText(destination?.deliveryText, 5000),
          forwardedContext: normalizeShortText(destination?.forwardedContext, 1200),
          titleHint: normalizeShortText(destination?.titleHint, 120),
        };
      })
      .filter((destination) => !!destination.mode);

    return {
      confidence,
      reasoning: normalizeShortText(parsed.reasoning, 320),
      userVisibleSummary: normalizeShortText(parsed.userVisibleSummary, 320),
      destinations,
    };
  } catch {
    return {
      confidence: 0,
      reasoning: 'json parse failure',
      userVisibleSummary: '',
      destinations: [],
    };
  }
}
