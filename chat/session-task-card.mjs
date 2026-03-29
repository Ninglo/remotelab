const TASK_CARD_TAG = 'task_card';
const MAX_TASK_CARD_TEXT_CHARS = 360;
const MAX_TASK_CARD_ITEM_CHARS = 180;
const MAX_TASK_CARD_ITEMS = 5;

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

function normalizeTaskCardMode(value) {
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

function normalizeTaskCardList(value, options = {}) {
  const maxItems = Number.isInteger(options.maxItems) && options.maxItems > 0
    ? options.maxItems
    : MAX_TASK_CARD_ITEMS;
  const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 0
    ? options.maxChars
    : MAX_TASK_CARD_ITEM_CHARS;
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

function hasMeaningfulTaskCard(card) {
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

export function normalizeSessionTaskCard(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const summary = clipText(value.summary || value.taskSummary || value.brief || '', MAX_TASK_CARD_TEXT_CHARS);
  const goal = clipText(value.goal || value.objective || '', 240);
  const background = normalizeTaskCardList(value.background || value.context || value.backgroundNotes);
  const rawMaterials = normalizeTaskCardList(value.rawMaterials || value.materials || value.sourceMaterials);
  const assumptions = normalizeTaskCardList(value.assumptions);
  const knownConclusions = normalizeTaskCardList(
    value.knownConclusions || value.conclusions || value.knownFindings || value.findings,
  );
  const reusablePatterns = normalizeTaskCardList(
    value.reusablePatterns || value.learnedPatterns || value.workingPatterns || value.heuristics || value.learnedStrategies,
  );
  const nextSteps = normalizeTaskCardList(value.nextSteps || value.nextActions || value.plan);
  const memory = normalizeTaskCardList(value.memory || value.userMemory || value.reusableContext || value.durableMemory);
  const needsFromUser = normalizeTaskCardList(
    value.needsFromUser || value.openQuestions || value.blockers || value.missingInputs,
  );
  const mode = normalizeTaskCardMode(
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

  return hasMeaningfulTaskCard(normalized) ? normalized : null;
}

function formatTaskCardList(label, items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  return `${label}:\n${items.map((item) => `- ${item}`).join('\n')}`;
}

export function buildTaskCardPromptBlock(taskCard) {
  const normalized = normalizeSessionTaskCard(taskCard);
  if (!normalized) return '';

  return [
    'Current carried task card (backend-owned hidden session memory):',
    `Execution mode: ${normalized.mode}`,
    normalized.summary ? `Summary: ${normalized.summary}` : '',
    normalized.goal ? `Goal: ${normalized.goal}` : '',
    formatTaskCardList('Background', normalized.background),
    formatTaskCardList('Raw materials', normalized.rawMaterials),
    formatTaskCardList('Assumptions', normalized.assumptions),
    formatTaskCardList('Known conclusions', normalized.knownConclusions),
    formatTaskCardList('Reusable patterns', normalized.reusablePatterns),
    formatTaskCardList('Next steps', normalized.nextSteps),
    formatTaskCardList('Durable user memory', normalized.memory),
    formatTaskCardList('Needs from user', normalized.needsFromUser),
    normalized.mode === 'project'
      ? 'This card currently treats the work as project-shaped: multi-step, recurring, or material-heavy.'
      : 'This card currently treats the work as a lightweight task rather than a larger project.',
  ].filter(Boolean).join('\n\n');
}

export function parseTaskCardFromAssistantContent(content) {
  const block = extractTaggedBlock(content, TASK_CARD_TAG);
  if (!block) return null;
  return normalizeSessionTaskCard(parseJsonObjectText(block));
}

export { TASK_CARD_TAG };
