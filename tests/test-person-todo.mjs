import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessTodo } from '../scripts/project-todo-judge.mjs';
import { buildProjectInspectionPlan } from '../scripts/project-inspection-plan.mjs';
import { collectTodoSources } from '../scripts/project-todo-collect.mjs';
import { collectOverview } from '../scripts/project-overview-collect.mjs';
const message = (id, sender, content, time = '2026-10-19T12:00:00Z') => ({ message_id: id, sender: { id: sender, sender_type: 'user' }, content, create_time: time });
const index = { chat_id: 'chat', messages: [message('original', 'bob', 'I will research the approach.'), message('copy', 'alice', 'Bob said: I will research the approach.'), message('delegate', 'alice', 'Please fix this.'), message('review', 'alice', 'I will review the draft.'), message('wait', 'alice', 'When the device arrives, connect it.'), message('next', 'agent', 'I am fixing it.')] };
const proof = (messageId, quote) => ({ messageId, quote });
const person = id => ({ kind: 'person', id });
const agent = { kind: 'agent' };
const base = (id, source, owner, next, availability = 'ready') => ({ id, title: id, disposition: 'in_progress', reason: 'Read the original request and its latest reply.', status: 'open', statusEvidence: proof(source, index.messages.find(m => m.message_id === source).content), sourceMessageIds: [source], relatedPersonIds: ['alice'], attribution: { mode: 'direct', speakerId: 'alice', evidence: proof(source, index.messages.find(m => m.message_id === source).content) }, owner: { actor: owner, evidence: proof(source, index.messages.find(m => m.message_id === source).content) }, next: { actor: next, text: 'Continue the original action.', availability, evidence: proof(source, index.messages.find(m => m.message_id === source).content), ...(availability !== 'ready' ? { condition: 'Wait for the recorded condition.' } : {}) } });
const research = base('research', 'copy', person('bob'), person('bob'));
research.relatedPersonIds = ['bob']; research.attribution = { mode: 'quoted', speakerId: 'bob', evidence: proof('original', 'I will research the approach.') };
const plan = { personTodoIds: ['alice'], todoSources: [{ chatId: 'chat', todoTarget: 'person-chat', windowStart: '2026-10-19T00:00:00Z', windowEnd: '2026-10-20T00:00:00Z', personIds: ['alice'] }] };
const judgments = { schemaVersion: 2, actions: [research, base('repair', 'delegate', agent, agent), base('draft', 'review', person('alice'), person('alice')), base('device', 'wait', agent, person('alice'), 'conditional'), { id: 'supporting', sourceMessageIds: ['original', 'next'], disposition: 'no_action', reason: 'Original attribution and execution evidence are included in the corresponding actions.' }] };
let result = assessTodo({ plan, indexes: [index], judgments });
assert.equal(result.validationComplete, true);
assert.deepEqual(result.views.alice.personal.map(a => a.id), ['draft']);
assert.deepEqual(result.views.alice.delegated.map(a => a.id), ['repair']);
assert.deepEqual(result.views.alice.waiting.map(a => a.id), ['device']);
assert.ok(!JSON.stringify(result.views.alice).includes('research'));
const passage = 'I will research the approach and compare the results with our original baseline before choosing the next experiment.';
const copiedIndex = structuredClone(index);
copiedIndex.messages[0].content = passage; copiedIndex.messages[1].content = 'A quoted plan: ' + passage;
const copied = structuredClone(judgments);
copied.actions[0] = base('copied-owner', 'copy', person('alice'), person('alice'));
copied.actions[0].attribution.evidence.quote = passage;
copied.actions[0].statusEvidence.quote = passage; copied.actions[0].owner.evidence.quote = passage; copied.actions[0].next.evidence.quote = passage;
const detected = assessTodo({ plan, indexes: [copiedIndex], judgments: copied });
assert.equal(detected.validationComplete, false);
assert.match(detected.invalid[0].errors.join(), /copied passage/);
assert.equal(assessTodo({ plan, indexes: [], judgments }).validationComplete, false, 'Missing input is not an empty successful scan');
const failedCollection = { groups: [{ chatId: 'chat', status: 'failed' }] };
assert.equal(assessTodo({ plan, indexes: [index], judgments, collection: failedCollection }).validationComplete, false);
const nestedIndex = structuredClone(index);
nestedIndex.messages = [ { ...index.messages[0], thread_replies: index.messages.slice(1) } ];
assert.equal(assessTodo({ plan, indexes: [nestedIndex], judgments }).validationComplete, true);
const wrong = structuredClone(judgments); wrong.actions[0].attribution.speakerId = 'alice';
result = assessTodo({ plan, indexes: [index], judgments: wrong });
assert.equal(result.validationComplete, false); assert.match(result.invalid[0].errors.join(), /Speaker/);
const missing = structuredClone(judgments); missing.actions = missing.actions.filter(a => a.id !== 'draft');
assert.ok(assessTodo({ plan, indexes: [index], judgments: missing }).coverage[0].missingJudgmentIds.includes('review'));
const fabricated = structuredClone(judgments); fabricated.actions[2].owner.evidence.quote = 'A nonexistent promise';
assert.equal(assessTodo({ plan, indexes: [index], judgments: fabricated }).validationComplete, false);
const extra = structuredClone(judgments); extra.actions[2].scheduledDate = '2026-10-20';
assert.equal(assessTodo({ plan, indexes: [index], judgments: extra }).validationComplete, false);
const blocked = structuredClone(judgments); blocked.actions[2].next.availability = 'blocked'; blocked.actions[2].next.condition = 'Interface not ready';
result = assessTodo({ plan, indexes: [index], judgments: blocked });
assert.deepEqual(result.views.alice.personal, []); assert.equal(result.views.alice.waiting.length, 2);
const resolved = structuredClone(judgments); resolved.actions[2].status = 'complete';
assert.equal(assessTodo({ plan, indexes: [index], judgments: resolved }).views.alice.archived.length, 1);
const other = structuredClone(judgments); other.actions[0].disposition = 'create';
assert.equal(assessTodo({ plan, indexes: [index], judgments: other }).registration[0].eligible, false);
const relatedOther = structuredClone(other); relatedOther.actions[0].relatedPersonIds.push('alice');
assert.equal(assessTodo({ plan, indexes: [index], judgments: relatedOther }).registration[0].eligible, false, 'Related person does not authorize assigning another person');
const newAction = base('another-review', 'review', person('alice'), person('alice'));
const dynamic = structuredClone(judgments); dynamic.actions.push(newAction);
assert.equal(assessTodo({ plan, indexes: [index], judgments: dynamic }).views.alice.personal.length, 2, 'No fixed IDs or count select the view');

const runtime = { enabled: true, reviewEnabled: true, projects: [{ id: 'p' }, { id: 'stop', status: 'paused' }], groups: [
  { chatId: 'focus', sourceRouteId: 'route', projectIds: ['p'], readingLevel: 'focused' },
  { chatId: 'overview', sourceRouteId: 'route', projectIds: [], readingLevel: 'overview' },
  { chatId: 'excluded', sourceRouteId: 'route', projectIds: [], readingLevel: 'excluded' },
  { chatId: 'paused', sourceRouteId: 'route', projectIds: ['stop'], readingLevel: 'focused' },
  { chatId: 'foreign', sourceRouteId: 'other', projectIds: [], readingLevel: 'overview' }] };
const registry = { sourceRouteId: 'route', targets: [], personTodoExpansion: { enabled: true, personIds: ['alice'], stateDirectory: '/state', initialStart: '2026-10-12T00:00:00Z' } };
const at = '2026-10-19T20:00:00Z';
const expanded = await buildProjectInspectionPlan({ runtime, registry, reviewRoot: '/review', at, load: async () => ({}) });
assert.deepEqual(expanded.todoSources.map(s => s.chatId), ['focus', 'overview']);
assert.deepEqual(expanded.sources.map(s => s.chatId), ['focus']);
assert.equal(expanded.todoSources[1].projectAnalysisEligible, false);
assert.equal(expanded.todoSources[1].windowStart, new Date(registry.personTodoExpansion.initialStart).toISOString());
const afternoon = await buildProjectInspectionPlan({ runtime, registry, reviewRoot: '/review', at: '2026-10-20T10:00:00Z', load: async () => ({}) });
assert.equal(afternoon.todoSources.length, 0);
const done = await buildProjectInspectionPlan({ runtime, registry, reviewRoot: '/review', at, load: async () => ({ lastSuccessfulScanEnd: at }) });
assert.equal(done.todoSources.length, 0);
const retry = await buildProjectInspectionPlan({ runtime, registry, reviewRoot: '/review', at, load: async path => path.includes('/state/') ? ({ lastSuccessfulScanEnd: at, pendingRetries: [{ sourceMessageId: 'old', threadId: 'old-thread' }] }) : {} });
assert.equal(retry.todoSources.length, 2); assert.ok(retry.todoSources[1].knownThreads.includes('old-thread'));

const dir = await mkdtemp(join(tmpdir(), 'person-todo-'));
try {
  await writeFile(join(dir, 'index-focus.json'), JSON.stringify({ chat_id: 'focus', messages: [] }));
  const seen = [];
  const request = async args => {
    seen.push(args);
    if (args.includes('+chat-messages-list')) {
      if (!args.includes('--page-token')) return { messages: [message('first', 'alice', 'first', '2026-10-19 12:00')].map(m => ({ ...m, thread_id: 'thread' })), has_more: true, page_token: 'next' };
      return { messages: [message('last', 'alice', 'last')], has_more: false };
    }
    return { messages: [message('reply', 'alice', 'reply')], has_more: false };
  };
  const manifest = await collectTodoSources(expanded, { indexes: dir, request });
  assert.equal(manifest.complete, true); assert.equal(seen.length, 3);
  const full = JSON.parse(await readFile(join(dir, 'index-overview.json')));
  assert.equal(full.messages.length, 3); assert.equal(full.messages[0].create_time, '2026-10-19T12:00Z');
  const overviewPlan = { ...expanded, overviewSources: expanded.overviewSources.filter(s => s.chatId === 'overview') };
  const reused = await collectOverview(overviewPlan, { indexes: dir, output: join(dir, 'overview'), request: async () => { throw Error('Must reuse'); } });
  assert.equal(reused.groups[0].status, 'reused'); assert.equal(reused.groups[0].analysisEligible, false);
  const failure = await collectTodoSources({ ...expanded, todoSources: [expanded.todoSources[1]] }, { indexes: join(dir, 'failure'), request: async () => ({ messages: [], has_more: true }) });
  assert.equal(failure.complete, false); assert.match(failure.groups[0].error, /pagination/);
} finally { await rm(dir, { recursive: true, force: true }); }
console.log('Person Todo attribution, dynamic views, coverage, source scope, cursor recovery and pagination checks passed.');
