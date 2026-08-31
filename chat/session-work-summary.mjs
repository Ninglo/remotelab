const WORK_SUMMARY_TAG = 'work_summary';
const LEGACY_TASK_CARD_TAG = 'task_card';
const MAX_WORK_SUMMARY_TEXT_CHARS = 360;
const MAX_WORK_SUMMARY_ITEM_CHARS = 180;
const MAX_WORK_SUMMARY_ITEMS = 5;

function clipText(value, maxChars) {
  const text = typeof value === 'string'
    ? value.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim()
    : '';
  if (!text || !Number.isInteger(maxChars) || maxChars <= 0 || text.length <= maxChars) {
    return text;
  }
  if (maxChars === 1) return '…';
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

function normalizeWorkSummaryMode(value) {
  if (value === true) return 'project';
  if (value === false) return 'task';
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return '';
  if (['project', 'project_mode', 'project-mode', 'projectmode'].includes(normalized)) {
    return 'project';
  }
  if (['task', 'single_task', 'single-task', 'session'].includes(normalized)) {
    return 'task';
  }
  return '';
}

function normalizeWorkSummaryList(value, options = {}) {
  const maxItems = Number.isInteger(options.maxItems) && options.maxItems > 0
    ? options.maxItems
    : MAX_WORK_SUMMARY_ITEMS;
  const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 0
    ? options.maxChars
    : MAX_WORK_SUMMARY_ITEM_CHARS;
  const rawItems = Array.isArray(value)
    ? value
    : (typeof value === 'string' && value.trim()
      ? value.split(/\n+/)
      : []);
  const items = [];
  const seen = new Set();
  for (const raw of rawItems) {
    const normalized = clipText(String(raw || '').replace(/^[-*•]\s*/, ''), maxChars);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(normalized);
    if (items.length >= maxItems) break;
  }
  return items;
}

function extractTaggedBlock(content, tagName) {
  const text = typeof content === 'string' ? content : '';
  if (!text || !tagName) return '';
  const match = text.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\/${tagName}>`, 'i'));
  return (match ? match[1] : '').trim();
}

function parseJsonObjectText(modelText) {
  const text = typeof modelText === 'string' ? modelText.trim() : '';
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
  }
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

function hasMeaningfulWorkSummary(card) {
  if (!card || typeof card !== 'object') return false;
  return Boolean(
    card.goal
    || card.summary
    || (card.background || []).length > 0
    || (card.rawMaterials || []).length > 0
    || (card.assumptions || []).length > 0
    || (card.knownConclusions || []).length > 0
    || (card.reusablePatterns || []).length > 0
    || (card.nextSteps || []).length > 0
    || (card.memory || []).length > 0
    || (card.needsFromUser || []).length > 0
  );
}

export function normalizeSessionWorkSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const summary = clipText(value.summary || value.taskSummary || value.brief || '', MAX_WORK_SUMMARY_TEXT_CHARS);
  const goal = clipText(value.goal || value.objective || '', 240);
  const background = normalizeWorkSummaryList(value.background || value.context || value.backgroundNotes);
  const rawMaterials = normalizeWorkSummaryList(value.rawMaterials || value.materials || value.sourceMaterials);
  const assumptions = normalizeWorkSummaryList(value.assumptions);
  const knownConclusions = normalizeWorkSummaryList(
    value.knownConclusions || value.conclusions || value.knownFindings || value.findings,
  );
  const reusablePatterns = normalizeWorkSummaryList(
    value.reusablePatterns || value.learnedPatterns || value.workingPatterns || value.heuristics || value.learnedStrategies,
  );
  const nextSteps = normalizeWorkSummaryList(value.nextSteps || value.nextActions || value.plan);
  const memory = normalizeWorkSummaryList(value.memory || value.userMemory || value.reusableContext || value.durableMemory);
  const needsFromUser = normalizeWorkSummaryList(
    value.needsFromUser || value.openQuestions || value.blockers || value.missingInputs,
  );
  const mode = normalizeWorkSummaryMode(
    value.mode
    || value.executionMode
    || value.projectState
    || value.projectMode,
  ) || (
    rawMaterials.length >= 3
    || nextSteps.length >= 2
    || background.length >= 2
      ? 'project'
      : 'task'
  );

  const normalized = {
    version: 1,
    mode,
    summary,
    goal,
    background,
    rawMaterials,
    assumptions,
    knownConclusions,
    reusablePatterns,
    nextSteps,
    memory,
    needsFromUser,
  };

  return hasMeaningfulWorkSummary(normalized) ? normalized : null;
}

function formatWorkSummaryList(label, items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  return `${label}:\n${items.map((item) => `- ${item}`).join('\n')}`;
}

export function buildWorkSummaryPromptBlock(workSummary) {
  const normalized = normalizeSessionWorkSummary(workSummary);
  if (!normalized) return '';

  return [
    'Current provider-neutral work summary (RemoteLab-managed cross-Harness continuity):',
    `Execution mode: ${normalized.mode}`,
    normalized.summary ? `Summary: ${normalized.summary}` : '',
    normalized.goal ? `Goal: ${normalized.goal}` : '',
    formatWorkSummaryList('Background', normalized.background),
    formatWorkSummaryList('Raw materials', normalized.rawMaterials),
    formatWorkSummaryList('Assumptions', normalized.assumptions),
    formatWorkSummaryList('Known conclusions', normalized.knownConclusions),
    formatWorkSummaryList('Reusable patterns', normalized.reusablePatterns),
    formatWorkSummaryList('Next steps', normalized.nextSteps),
    formatWorkSummaryList('Session-scoped reusable context', normalized.memory),
    formatWorkSummaryList('Needs from user', normalized.needsFromUser),
    normalized.mode === 'project'
      ? 'This summary treats the work as project-shaped: multi-step, recurring, or material-heavy.'
      : 'This summary treats the work as a lightweight task rather than a larger project.',
  ].filter(Boolean).join('\n\n');
}

export function parseWorkSummaryFromAssistantContent(content) {
  const block = extractTaggedBlock(content, WORK_SUMMARY_TAG) || extractTaggedBlock(content, LEGACY_TASK_CARD_TAG);
  if (!block) return null;
  return normalizeSessionWorkSummary(parseJsonObjectText(block));
}

export { WORK_SUMMARY_TAG };
