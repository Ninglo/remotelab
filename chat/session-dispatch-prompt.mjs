/**
 * Prompt construction for the pre-execution session dispatch classifier.
 *
 * The classifier decides whether an incoming user message belongs in the
 * current session or should be routed to an existing/new session.
 */

function clipText(text, maxChars = 500) {
  const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars).trimEnd()}…`;
}

function formatSessionSummary(session) {
  if (!session?.id) return '';
  const parts = [`- id: ${session.id}`];
  if (session.name) parts.push(`  name: ${session.name}`);
  if (session.group) parts.push(`  group: ${session.group}`);
  if (session.description) parts.push(`  description: ${clipText(session.description, 120)}`);
  if (session.templateId) {
    parts.push(`  agent: ${session.templateName || session.templateId}`);
  }
  if (session.sourceId && session.sourceId !== 'chat') {
    parts.push(`  source: ${session.sourceName || session.sourceId}`);
  }
  return parts.join('\n');
}

function formatAgentSummary(agent) {
  if (!agent?.id) return '';
  const parts = [`- id: ${agent.id}, name: ${agent.name || agent.id}`];
  const hints = agent.scopeHints;
  if (hints?.description) parts.push(`  scope: ${clipText(hints.description, 120)}`);
  if (hints?.triggers?.length) parts.push(`  triggers: ${hints.triggers.join(', ')}`);
  return parts.join('\n');
}

export function buildDispatchClassifierPrompt({
  currentSession,
  message,
  recentSessions = [],
  availableAgents = [],
}) {
  const currentSummary = formatSessionSummary(currentSession);
  const otherSessions = recentSessions
    .filter((s) => s.id !== currentSession?.id && !s.archived)
    .slice(0, 15)
    .map(formatSessionSummary)
    .filter(Boolean)
    .join('\n');

  const agentSummaries = availableAgents
    .filter((agent) => agent.scopeHints?.triggers?.length || agent.scopeHints?.description)
    .map(formatAgentSummary)
    .filter(Boolean)
    .join('\n');

  const messageText = clipText(message, 2000);

  return [
    'You are RemoteLab\'s hidden session dispatch classifier.',
    'Decide whether the incoming user message belongs in the current session or should be routed elsewhere.',
    '',
    'Rules:',
    '- Default to "continue" when uncertain. False routing is worse than no routing.',
    '- Only route away when the message is clearly about a different topic/domain than the current session.',
    '- Natural topic evolution within the same domain is NOT a reason to route away.',
    '- If the current session has no established topic yet (new/empty session), always "continue".',
    '- Short messages like greetings, acknowledgments, or follow-ups almost always belong in the current session.',
    '- When routing to an existing session, pick the one whose topic most closely matches the new message.',
    '- When no existing session matches but the topic is clearly different, use "route_new".',
    '- If an available Agent\'s scope clearly matches the message, include its id as targetAgentId.',
    '',
    'Current session:',
    currentSummary || '(new/empty session)',
    '',
    otherSessions ? `Other active sessions:\n${otherSessions}` : 'No other active sessions.',
    '',
    agentSummaries ? `Available Agents with scope hints:\n${agentSummaries}` : '',
    '',
    'Incoming message:',
    messageText || '(empty)',
    '',
    'Return exactly one JSON object inside a <hide> block with these keys:',
    '- "action": "continue" | "route_existing" | "route_new"',
    '- "confidence": number 0-1',
    '- "reason": short explanation in the user\'s language',
    '- "targetSessionId": string (only for route_existing, must be an id from the list above)',
    '- "targetAgentId": string (optional, an Agent id if the message matches an Agent scope)',
    '',
    'Do not output any text outside the <hide> block.',
  ].filter((line) => line !== undefined).join('\n');
}

export function parseDispatchDecision(content) {
  const text = String(content || '').trim();

  // Extract <hide> block
  const hideMatch = text.match(/<hide>([\s\S]*?)<\/hide>/i);
  const jsonSource = hideMatch ? hideMatch[1].trim() : text;

  // Find JSON object
  const jsonMatch = jsonSource.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { action: 'continue', confidence: 0, reason: 'parse failure' };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const action = ['continue', 'route_existing', 'route_new'].includes(parsed.action)
      ? parsed.action
      : 'continue';
    const confidence = typeof parsed.confidence === 'number'
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0;
    return {
      action,
      confidence,
      reason: String(parsed.reason || '').slice(0, 200),
      targetSessionId: typeof parsed.targetSessionId === 'string' ? parsed.targetSessionId.trim() : '',
      targetAgentId: typeof parsed.targetAgentId === 'string'
        ? parsed.targetAgentId.trim()
        // Backward compatibility for older hidden dispatch outputs.
        : (typeof parsed.targetAppId === 'string' ? parsed.targetAppId.trim() : ''),
    };
  } catch {
    return { action: 'continue', confidence: 0, reason: 'json parse failure' };
  }
}
