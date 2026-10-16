// Explicit project discovery over the existing runtime registry and briefs.
// Reads never bind a Session or change the authority of a matched source.
import { loadProjectMemoryRuntime, PROJECT_MEMORY_RUNTIME_FILE } from './project-memory-runtime.mjs';
import { projectDirectoryScope } from './project-work-scope.mjs';
import { loadSessionsMeta } from './session-meta-store.mjs';
import { readMemoryDocument } from './memory-document.mjs';
import { topicSearchTerms } from './topic-memory-context.mjs';

export async function readProjectTopicContext(session = {}, sourceContext, { query = '', projectId = '', configPath,
  sessions, maxChars = 6000 } = {}) {
  let loaded;
  try { loaded = await loadProjectMemoryRuntime(configPath); }
  catch { return { result: 'source-unavailable', association: 'not-inferred',
    reason: 'Project registry unavailable; use the original project pointers. This does not mean no project exists.' }; }
  const { config, hash } = loaded;
  if (!config.enabled || !config.contextEnabled) return { result: 'not-enabled', association: 'not-inferred' };
  if (projectId && !config.projects.some(p => p.id === projectId)) {
    throw Object.assign(new Error('Unknown registered project: ' + projectId), { statusCode: 400 });
  }
  const scope = projectDirectoryScope(config, session, sourceContext,
    sessions || (config.directoryEnabled ? await loadSessionsMeta() : [session]));
  const selectedIds = projectId ? [projectId] : scope.projectIds;
  const cues = topicSearchTerms(query);
  const describe = p => ({ projectId: p.id, name: p.name || p.id, status: p.status || 'not-recorded',
    ...(p.parentId ? { parentId: p.parentId } : {}),
    ...(p.pauseReason ? { pauseReason: p.pauseReason } : {}),
    skills: p.skills || [],
    briefPath: p.briefPath || null, briefUrl: p.briefUrl || null,
    groupCount: config.groups.filter(g => g.projectIds.includes(p.id)).length });
  const candidates = config.projects.flatMap(p => {
    const text = [p.id, p.name].filter(Boolean).join(' ').toLowerCase();
    const matchedTerms = cues.filter(cue => text.includes(cue));
    return matchedTerms.length ? [{ ...describe(p), matchedTerms, authority: 'reference-only' }] : [];
  }).sort((a, b) => b.matchedTerms.length - a.matchedTerms.length || a.projectId.localeCompare(b.projectId));
  const selected = [];
  let remaining = Math.min(6000, Math.max(0, maxChars));
  for (const id of selectedIds) {
    const p = config.projects.find(p => p.id === id);
    if (!p) continue;
    const doc = p.briefPath ? await readMemoryDocument(p.briefPath, 48 * 1024) : { status: 'not-recorded' };
    const { text, ...metadata } = doc;
    const fits = doc.status === 'available' && text.length <= remaining;
    selected.push({ ...describe(p), source: { ...metadata, ...(fits ? { body: text, lineStart: 1,
      lineEnd: text.split('\n').length } : doc.status === 'available' ? { result: 'budget-skipped',
      reason: 'Read the original brief; decisions and corrections may be outside the budget.' } : {}) } });
    if (fits) remaining -= text.length;
  }
  return { result: selected.length ? selected.every(p => p.source.body !== undefined) ? 'found' : 'partial'
    : candidates.length ? 'candidates' : 'no-match-in-registered-project-names',
    registryPath: configPath || PROJECT_MEMORY_RUNTIME_FILE, configVersion: hash.slice(0, 16),
    confirmedProjectIds: scope.projectIds, scopeSessionId: scope.viaSessionId || null,
    association: projectId ? 'explicit-reference-selection' : scope.projectIds.length ? 'registered-scope' : 'not-inferred',
    selected, candidates: candidates.slice(0, 6), omittedCount: Math.max(0, candidates.length - 6),
    index: config.indexPath, ledger: config.ledgerPath,
    boundary: 'Candidates match registered names only; they are not confirmed ownership. Explicit --project reads a reference, '
      + 'never binds or switches the Session. Read the current brief, original decisions and applicable rules before adopting them '
      + 'for this task; ask a concrete question when ownership is unclear. Keep existing bindings and real parent scope as evidence. '
      + 'Do not carry another project\'s constraints into a new topic. Paused/cancelled work stays historical unless explicitly resumed. '
      + 'File hashes describe current reads, not live execution state or new permission. Missing or skipped sources remain gaps.' };
}

export async function buildWebTopicDiscoveryPrompt(session, { sourceContext, automated = false } = {}) {
  if (!session?.id || automated || sourceContext?.connector) return '';
  try {
    const { config } = await loadProjectMemoryRuntime();
    if (!config.enabled || !config.contextEnabled) return '';
  } catch { return ''; }
  return 'Web topic background lookup: this Web input may start an independent topic. Existing explicit project bindings and real delegation parents are the first scope evidence. '
    + 'For work needing earlier background, decisions or project rules, use `remotelab work context --query <understood goal> --json`. '
    + 'The response includes unconfirmed project and work candidates with source pointers. Read the relevant originals; '
    + '`remotelab work context --query <goal> --project <registered-id> --json` reads that project brief as a reference, and '
    + '`remotelab work directory --project <registered-id> --json` reads its topic directory without binding this Session. '
    + 'Use the corresponding current background and applicable rules only after checking the task and sources; cite them when they affect the answer. '
    + 'If multiple projects fit, preserve candidates and ask a specific question while continuing independent work. '
    + 'A topic change does not inherit the previous project\'s limits. Re-read changed sources and corrections, explain missing coverage, '
    + 'and never treat a search hit as permission, accepted ownership or a reason to resume paused/cancelled work. '
    + 'Simple self-contained questions do not need background retrieval. Guide: `$REMOTELAB_PROJECT_ROOT/docs/session-work-awareness.md`.';
}
