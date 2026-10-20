import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkTodoCoverage, timestamp } from './check-todo-coverage.mjs';

const values = x => Array.isArray(x) ? x : Object.values(x || {});
const flattened = index => {
  const all = new Map();
  const add = m => { if (m?.message_id) all.set(m.message_id, m); for (const r of m?.thread_replies || []) add(r); };
  values(index?.messages).forEach(add); return [...all.values()];
};
const same = (actor, personId) => actor?.kind === 'person' && actor.id === personId;
const actorValid = a => ['person', 'agent', 'unknown'].includes(a?.kind) && (a.kind !== 'person' || Boolean(a.id));

// The Harness interprets meaning. This boundary checks evidence references and
// projects its decisions; it neither infers ownership from words nor writes tasks.
export function assessTodo({ plan, indexes, judgments, evidence = [], collection }) {
  const messages = new Map();
  const add = m => { if (m?.message_id) messages.set(m.message_id, m); for (const r of m?.thread_replies || []) add(r); };
  indexes.forEach(i => values(i.messages).forEach(add)); evidence.forEach(add);
  const freshStart = plan.personTodoNewActivitySince == null ? null : timestamp(plan.personTodoNewActivitySince);
  if (freshStart !== null && !Number.isFinite(freshStart)) throw new Error('Invalid person Todo new-activity boundary');
  const valid = [], invalid = [], ids = new Set(), attributionChecks = [];
  const normalized = text => String(text || '').replace(/\s+/g, ' ').trim();
  const proof = p => typeof p?.quote === 'string' && p.quote.trim().length > 0
    && typeof messages.get(p.messageId)?.content === 'string' && messages.get(p.messageId).content.includes(p.quote);
  if (judgments.schemaVersion !== 2 || !Array.isArray(judgments.actions)) throw new Error('Todo judgments schemaVersion 2 and actions are required');
  for (const action of judgments.actions) {
    const errors = [];
    if (!action.id || ids.has(action.id)) errors.push('Missing or duplicate action ID');
    ids.add(action.id);
    if (!Array.isArray(action.sourceMessageIds) || !action.sourceMessageIds.length || action.sourceMessageIds.some(id => !messages.has(id))) errors.push('Missing source messages');
    if (!['create', 'clarify', 'update', 'covered', 'in_progress', 'resolved', 'no_action', 'needs_evidence'].includes(action.disposition) || !action.reason?.trim()) errors.push('Missing disposition or reason');
    if (action.disposition !== 'no_action') {
      if (!action.title?.trim() || !['open', 'complete', 'paused', 'cancelled', 'unknown'].includes(action.status)) errors.push('Missing title or status');
      if (!Array.isArray(action.relatedPersonIds)) errors.push('Missing related people');
      if (!proof(action.statusEvidence)) errors.push('Missing current-status evidence');
      const attribution = action.attribution;
      if (!['direct', 'quoted', 'forwarded', 'unresolved'].includes(attribution?.mode)) errors.push('Missing attribution');
      if (attribution?.mode !== 'unresolved') {
        if (!proof(attribution?.evidence)) errors.push('Missing attribution quote');
        else if (messages.get(attribution.evidence.messageId)?.sender?.id !== attribution.speakerId) errors.push('Speaker does not match the cited original message');
      } else if (!attribution.reason?.trim()) errors.push('Unresolved attribution needs a reason');
      if (attribution?.mode === 'direct' && proof(attribution.evidence)) {
        const cited = messages.get(attribution.evidence.messageId);
        const body = normalized(cited.content);
        const copies = [...messages.values()].filter(m => m.message_id !== cited.message_id
          && m.sender?.sender_type === 'user' && m.sender.id !== cited.sender?.id
          && normalized(m.content).length >= 80 && body.includes(normalized(m.content))).map(m => m.message_id);
        if (copies.length) {
          attributionChecks.push({ actionId: action.id, messageId: cited.message_id, otherSpeakerMessageIds: copies });
          if (!attribution.reason?.trim() || copies.some(id => !attribution.reviewedMessageIds?.includes(id))) errors.push('Cross-speaker copied passage requires explicit attribution review');
        }
      }
      if (!actorValid(action.owner?.actor) || !proof(action.owner?.evidence)) errors.push('Missing owner evidence');
      if (!actorValid(action.next?.actor) || !action.next?.text?.trim() || !proof(action.next?.evidence)) errors.push('Missing next-action evidence');
      if (!['ready', 'blocked', 'conditional', 'unknown'].includes(action.next?.availability)) errors.push('Missing action availability');
      if (['blocked', 'conditional', 'unknown'].includes(action.next?.availability) && !action.next?.condition?.trim()) errors.push('Missing dependency or unknown');
      if (action.scheduledDate && (!/^\d{4}-\d{2}-\d{2}$/.test(action.scheduledDate) || !proof(action.timingEvidence))) errors.push('Missing date evidence');
    }
    (errors.length ? invalid : valid).push(errors.length ? { id: action.id, sourceMessageIds: action.sourceMessageIds, errors } : action);
  }
  const coverage = (plan.todoSources || plan.sources || []).filter(s => s.todoTarget).map(source => {
    const index = indexes.find(i => i.chat_id === source.chatId);
    const local = new Set(flattened(index).map(m => m.message_id));
    const actions = valid.map(a => ({ ...a, sourceMessageIds: a.sourceMessageIds.filter(id => local.has(id)) })).filter(a => a.sourceMessageIds.length);
    const result = checkTodoCoverage({ source, index, judgments: { actions } });
    if (index?.complete === false) result.errors.push('Source collection is incomplete');
    if (collection) {
      const row = collection.groups?.find(r => r.chatId === source.chatId);
      if (!row || !['read', 'reused'].includes(row.status) || row.windowStart !== source.windowStart || row.windowEnd !== source.windowEnd) result.errors.push('Missing, failed or stale source collection receipt');
    }
    result.coverageComplete = result.coverageComplete && !result.errors.length;
    return result;
  });
  // Shared collection may retain old project context; a personal cutover must
  // not turn that historical backlog into newly assigned work.
  const skippedHistorical = valid.filter(action => action.disposition !== 'no_action' && freshStart !== null
    && (plan.personTodoIds || []).some(id => action.relatedPersonIds.includes(id) || same(action.owner.actor, id) || same(action.next.actor, id))
    && !action.sourceMessageIds.some(id => {
      const message = messages.get(id), at = timestamp(message?.create_time);
      return message?.sender?.sender_type === 'user' && at >= freshStart
        && (!plan.scheduledAt || at < timestamp(plan.scheduledAt));
    })).map(action => action.id);
  const skipped = new Set(skippedHistorical);
  const views = {};
  for (const personId of plan.personTodoIds || []) {
    const view = { personal: [], delegated: [], waiting: [], needsReview: [], archived: [] };
    for (const action of valid) {
      if (action.disposition === 'no_action' || skipped.has(action.id)) continue;
      if (!action.relatedPersonIds.includes(personId) && !same(action.owner.actor, personId) && !same(action.next.actor, personId)) continue;
      let bucket;
      if (['complete', 'paused', 'cancelled'].includes(action.status)) bucket = 'archived';
      else if (action.attribution.mode === 'unresolved' || action.status === 'unknown' || action.next.actor.kind === 'unknown') bucket = 'needsReview';
      else if (action.next.availability !== 'ready') bucket = 'waiting';
      else bucket = same(action.next.actor, personId) ? 'personal' : 'delegated';
      view[bucket].push(action);
    }
    views[personId] = view;
  }
  const registration = valid.filter(a => a.disposition === 'create' || a.disposition === 'clarify').map(action => {
    if (skipped.has(action.id)) return { id: action.id, eligible: false, reason: 'Historical personal backlog excluded by the authorized new-activity boundary' };
    const sources = (plan.todoSources || plan.sources || []).filter(s => action.sourceMessageIds.some(id => flattened(indexes.find(i => i.chat_id === s.chatId)).some(m => m.message_id === id)));
    const eligible = sources.some(s => !s.personIds || (s.personIds.some(id => action.relatedPersonIds?.includes(id) || same(action.owner?.actor, id))
      && [action.owner?.actor, action.next?.actor].every(a => a?.kind !== 'person' || s.personIds.includes(a.id))));
    return { id: action.id, eligible, reason: eligible ? 'Within original or configured person scope; original task write/readback rules still apply' : 'Outside configured people; preserve candidate without reassignment' };
  });
  return { schemaVersion: 2, validationComplete: invalid.length === 0 && coverage.every(c => c.coverageComplete),
    coverage, invalid, attributionChecks, views, registration, skippedHistorical, boundary: 'Evidence and coverage checks, not a semantic score or a task-write receipt' };
}
async function main() {
  const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a, []));
  for (const key of ['plan', 'indexes', 'judgments', 'output']) if (!args[key]) throw new Error(`--${key} required`);
  const read = async p => JSON.parse(await readFile(p, 'utf8'));
  const plan = await read(args.plan), indexes = [];
  for (const source of [...(plan.sources || []), ...(plan.todoSources || [])]) {
    if (indexes.some(i => i.chat_id === source.chatId)) continue;
    try { indexes.push(await read(join(args.indexes, `index-${source.chatId}.json`))); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  const output = resolve(args.output);
  if ([args.plan, args.judgments, args.evidence].filter(Boolean).some(p => resolve(p) === output)) throw new Error('Output must not overwrite input');
  const result = assessTodo({ plan, indexes, judgments: await read(args.judgments), evidence: args.evidence ? await read(args.evidence) : [],
    collection: await read(join(args.indexes, 'todo-collection.json')) });
  await writeFile(output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ validationComplete: result.validationComplete, invalid: result.invalid.length,
    missingJudgments: result.coverage.reduce((n, c) => n + c.missingJudgmentIds.length, 0), output }));
  if (!result.validationComplete) process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(e => { console.error(e.message); process.exitCode = 1; });
