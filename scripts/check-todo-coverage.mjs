import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function timestamp(value) {
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const n = Number(value);
    return n < 1e12 ? n * 1000 : n;
  }
  // The local message collector records wall time in Asia/Shanghai.
  if (/^\d{4}-\d\d-\d\d \d\d:\d\d(?::\d\d)?$/.test(value || '')) {
    return Date.parse(value.replace(' ', 'T') + '+08:00');
  }
  return Date.parse(value);
}

// Checks source coverage only. The Harness still judges meaning, task permissions,
// completion evidence, successful writes, and whether any notification is warranted.
export function checkTodoCoverage({ source, index, judgments }) {
  const errors = [];
  if (!source?.todoTarget || !source.chatId) errors.push('Missing planned Todo target');
  if (index?.chat_id !== source?.chatId) errors.push('Source chat does not match the plan');
  const start = source?.windowStart == null ? -Infinity : timestamp(source.windowStart);
  const end = timestamp(source?.windowEnd);
  if (!(start < end) || !Number.isFinite(end)) errors.push('Invalid planned window');
  const raw = index?.messages;
  if (!raw || typeof raw !== 'object') errors.push('Missing source messages');
  const messages = Array.isArray(raw) ? raw : Object.values(raw || {});
  const available = new Set();
  const required = new Set(source?.requiredMessageIds || []);
  for (const message of messages) {
    const id = message.message_id;
    if (!id) { errors.push('Source message has no ID'); continue; }
    available.add(id);
    if (message.sender?.sender_type !== 'user') continue;
    const at = timestamp(message.create_time);
    if (!Number.isFinite(at)) { errors.push(`Invalid source time: ${id}`); continue; }
    if (at >= start && at < end) required.add(id);
  }
  const actions = judgments?.actions;
  if (!Array.isArray(actions)) errors.push('Missing action judgments');
  const dispositions = new Set(['create', 'clarify', 'update', 'covered', 'in_progress', 'resolved', 'no_action', 'needs_evidence']);
  const reviewed = new Set();
  for (const [i, action] of (Array.isArray(actions) ? actions : []).entries()) {
    if (!dispositions.has(action.disposition) || typeof action.reason !== 'string' || !action.reason.trim()) {
      errors.push(`Invalid decision or missing reason: action ${i}`);
    }
    if (!Array.isArray(action.sourceMessageIds) || !action.sourceMessageIds.length) {
      errors.push(`Missing source IDs: action ${i}`); continue;
    }
    for (const id of action.sourceMessageIds) {
      if (!available.has(id)) errors.push(`Judgment source not collected: ${id}`);
      reviewed.add(id);
    }
  }
  const missingSourceIds = [...required].filter(id => !available.has(id));
  const missingJudgmentIds = [...required].filter(id => !reviewed.has(id));
  return { target: source?.todoTarget, windowStart: source?.windowStart, windowEnd: source?.windowEnd,
    requiredMessages: required.size, reviewedMessages: [...required].filter(id => reviewed.has(id)).length,
    missingSourceIds, missingJudgmentIds, errors,
    coverageComplete: !errors.length && !missingSourceIds.length && !missingJudgmentIds.length,
    boundary: 'Coverage only; not semantic acceptance, write confirmation, or cursor advancement.' };
}

async function main() {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
  for (const key of ['plan', 'target', 'index', 'judgments', 'output']) if (!args[key]) throw new Error(`--${key} is required`);
  const read = async path => JSON.parse(await readFile(path, 'utf8'));
  const [plan, index, judgments] = await Promise.all([read(args.plan), read(args.index), read(args.judgments)]);
  const source = plan.sources?.find(s => s.todoTarget === args.target);
  if (!source) throw new Error('Target is not in this inspection plan');
  const output = resolve(args.output);
  if ([args.plan, args.index, args.judgments].some(p => resolve(p) === output)) throw new Error('Output must not overwrite an input');
  const result = checkTodoCoverage({ source, index, judgments });
  await writeFile(output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(result));
  if (!result.coverageComplete) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
