const BUILTIN_AGENT_IDS = new Set(['', 'chat', 'email']);

function normalizeAgentId(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function isIndependentAgentInvocation(session) {
  const templateId = normalizeAgentId(session?.templateId);
  return !BUILTIN_AGENT_IDS.has(templateId);
}

export function buildAgentInvocationContextBoundary(session) {
  if (!isIndependentAgentInvocation(session)) return '';

  return [
    'Independent Agent invocation boundary (backend-owned; takes precedence over Agent template instructions):',
    '- Treat this session as a fresh, independent invocation of the Agent, not as a continuation of the session that created, tested, or previously used it.',
    '- Current task context may come only from messages and attachments in this session, references the user explicitly supplies in this session, and any template context deliberately bundled into this Agent definition.',
    '- Do not read, import, or act on prior sessions, task/project memory, historical campaigns, old datasets, earlier documents/tables, or local task artifacts merely because they are discoverable on this machine.',
    '- Reusable skills, stable operating rules, and connector/configuration availability are capabilities and may be used. Prior business records and task conclusions are context and require explicit scope from the user.',
    '- If historical material could help, first tell the user what kind of material is available at a high level and ask whether it should be reused. Do not inspect its detailed contents or let it change the current run before that opt-in.',
    '- The user may opt in by naming or linking the prior campaign/session/document/data, or by explicitly asking to continue, migrate, compare, deduplicate against, or reuse it. Once opted in, use only the named scope.',
  ].join('\n');
}
