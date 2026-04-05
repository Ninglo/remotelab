/**
 * Post-turn memory writeback.
 *
 * After a turn completes, evaluates whether anything durable was learned
 * and writes it back to the appropriate memory layer.
 *
 * This runs as part of the turn-close autonomy window, fully async and
 * non-blocking to the user.
 */

import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { extractTaggedBlock, parseJsonObjectText } from './session-text-parsing.mjs';
import { MODEL_CONTEXT_DIR } from './prompt-paths.mjs';

const WRITEBACK_SETTING_ENV = 'REMOTELAB_MEMORY_WRITEBACK';
const SESSION_LEARNINGS_DIR = join(MODEL_CONTEXT_DIR, 'session-learnings');

function normalizeWritebackSetting(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || ['0', 'false', 'off', 'disabled', 'disable'].includes(normalized)) {
    return 'off';
  }
  if (['1', 'true', 'on', 'enabled', 'enable'].includes(normalized)) {
    return 'on';
  }
  return normalized;
}

function isWritebackEnabled() {
  return normalizeWritebackSetting(process.env[WRITEBACK_SETTING_ENV]) === 'on';
}

function clipText(text, maxChars = 3000) {
  const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars).trimEnd()}…`;
}

export function buildMemoryWritebackPrompt({ userMessage, assistantTurnText, sessionName, sessionGroup }) {
  return [
    'You are RemoteLab\'s hidden post-turn memory reviewer.',
    'Evaluate whether the just-completed conversation turn produced any durable, reusable knowledge worth persisting.',
    '',
    'What counts as worth persisting:',
    '- Stable user preferences confirmed across interaction (not one-off requests)',
    '- Recurring workflow patterns the user relies on',
    '- Key decisions or conclusions the user accepted',
    '- Facts about the user\'s environment, tools, or constraints',
    '- Solutions to problems that are likely to recur',
    '',
    'What does NOT count:',
    '- Session-specific task details or in-progress work',
    '- Information that\'s already obvious from context',
    '- Speculative or unverified conclusions',
    '- Trivial exchanges (greetings, acknowledgments)',
    '',
    'Session context:',
    sessionName ? `Session: ${sessionName}` : '',
    sessionGroup ? `Group: ${sessionGroup}` : '',
    '',
    'User message:',
    clipText(userMessage, 2000) || '[none]',
    '',
    'Assistant response:',
    clipText(assistantTurnText, 3000) || '[none]',
    '',
    'Return a JSON object inside a <hide> block with these keys:',
    '- "shouldWrite": boolean — true only if something genuinely durable was learned',
    '- "learnings": array of objects, each with:',
    '  - "category": string — one of "preference", "workflow", "decision", "environment", "solution"',
    '  - "content": string — the concise learning to persist',
    '  - "layer": string — "user" (personal/machine-specific) or "system" (universal cross-deployment)',
    '',
    'If shouldWrite is false, return an empty learnings array.',
    'Write learnings in the user\'s language.',
    'Do not output any text outside the <hide> block.',
  ].filter((line) => line !== undefined).join('\n');
}

export function parseWritebackDecision(content) {
  const text = String(content || '').trim();
  const hidden = extractTaggedBlock(text, 'hide');
  const parsed = parseJsonObjectText(hidden || text);

  if (!parsed || parsed.shouldWrite !== true) {
    return { shouldWrite: false, learnings: [] };
  }

  const learnings = Array.isArray(parsed.learnings)
    ? parsed.learnings
        .filter((l) => l && typeof l.content === 'string' && l.content.trim())
        .map((l) => ({
          category: ['preference', 'workflow', 'decision', 'environment', 'solution'].includes(l.category)
            ? l.category
            : 'decision',
          content: l.content.trim().slice(0, 500),
          layer: l.layer === 'system' ? 'system' : 'user',
        }))
    : [];

  return { shouldWrite: learnings.length > 0, learnings };
}

async function ensureDir(dirPath) {
  try {
    await mkdir(dirPath, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

async function appendToLearningsFile(learnings, sessionId, sessionName) {
  if (!learnings.length) return;

  await ensureDir(SESSION_LEARNINGS_DIR);
  const filePath = join(SESSION_LEARNINGS_DIR, 'learnings.jsonl');
  const timestamp = new Date().toISOString();

  const lines = learnings.map((learning) => JSON.stringify({
    ...learning,
    sessionId: sessionId?.slice(0, 12) || '',
    sessionName: sessionName?.slice(0, 60) || '',
    timestamp,
  }));

  await writeFile(filePath, lines.join('\n') + '\n', { flag: 'a' });
}

/**
 * Evaluate and persist any durable learnings from the completed turn.
 *
 * @param {object} params
 * @param {string} params.sessionId
 * @param {object} params.session - Session metadata
 * @param {object} params.run - Completed run
 * @param {string} params.userMessage - The user's message text
 * @param {string} params.assistantTurnText - The assistant's response text
 * @param {Function} params.runPrompt - Async fn for one-shot LLM call
 * @returns {Promise<object>} Writeback result
 */
export async function maybeRunMemoryWriteback({
  sessionId,
  session,
  run,
  userMessage,
  assistantTurnText,
  runPrompt,
}) {
  if (!isWritebackEnabled()) {
    return { attempted: false, written: false };
  }

  // Skip trivial turns
  if (!userMessage || !assistantTurnText) {
    return { attempted: false, written: false };
  }
  if (assistantTurnText.length < 100) {
    return { attempted: false, written: false };
  }

  const prompt = buildMemoryWritebackPrompt({
    userMessage,
    assistantTurnText,
    sessionName: session?.name || '',
    sessionGroup: session?.group || '',
  });

  let rawResponse = '';
  try {
    rawResponse = await runPrompt(prompt);
  } catch (error) {
    console.error(`[memory-writeback] Classifier failed for ${sessionId?.slice(0, 8)}: ${error.message}`);
    return { attempted: true, written: false };
  }

  const decision = parseWritebackDecision(rawResponse);
  if (!decision.shouldWrite || decision.learnings.length === 0) {
    return { attempted: true, written: false };
  }

  try {
    await appendToLearningsFile(decision.learnings, sessionId, session?.name);
    console.log(
      `[memory-writeback] Wrote ${decision.learnings.length} learning(s) from session ${sessionId?.slice(0, 8)}`
    );
    return { attempted: true, written: true, count: decision.learnings.length };
  } catch (error) {
    console.error(`[memory-writeback] Write failed for ${sessionId?.slice(0, 8)}: ${error.message}`);
    return { attempted: true, written: false };
  }
}
