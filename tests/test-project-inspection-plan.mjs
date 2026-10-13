import assert from 'node:assert/strict';
import { buildProjectInspectionPlan } from '../scripts/project-inspection-plan.mjs';
import { researchCandidateHandoff } from '../scripts/research-candidate-handoff.mjs';
import { checkTodoCoverage } from '../scripts/check-todo-coverage.mjs';

const runtime = { enabled: true, reviewEnabled: true, projects: [{ id: 'a' }, { id: 'paused', status: 'paused' }],
  groups: [{ chatId: 'a', projectIds: ['a'] }, { chatId: 'paused', projectIds: ['paused'] }, { chatId: 'b', projectIds: ['a'] }] };
const registry = { tasklistGuid: 'one-list', targets: [{ key: 'a', chatId: 'a', enabled: true, stateFile: '/todo/a' },
  { key: 'paused', chatId: 'paused', enabled: true }, { key: 'unauthorized', chatId: 'outside', enabled: true }] };
const files = { '/review/chat-sync/checkpoints/a.json': { collection_completed_at_utc: '2026-10-09T10:00:00Z', threads: { original: { lastSeenMessageId: 'root' } } },
  '/todo/a': { lastSuccessfulScanEnd: '2026-10-07T20:00:00Z', knownThreads: [{ threadId: 'todo-thread' }] } };
const before = JSON.stringify(files);
const build = (at, overrides = {}) => buildProjectInspectionPlan({ runtime, registry, reviewRoot: '/review', at,
  load: async (path, fallback) => files[path] || fallback, ...overrides });
const morning = await build('2026-10-09T20:00:00Z');
assert.equal(morning.phase, 'morning');
assert.equal(morning.localDate, '2026-10-10');
assert.deepEqual(morning.todoTargets.map(t => t.key), ['a'], 'paused and outside-scope targets cannot become actionable');
assert.equal(morning.sources[0].windowStart, '2026-10-05T20:00:00.000Z', 'backlogged Todo extends the shared collection window');
assert.deepEqual(morning.sources[0].knownThreads, ['original', 'todo-thread'], 'old unresolved threads survive consolidation');
assert.equal(morning.sources[1].windowStart, null, 'an absent baseline requests a complete initial read');
assert.equal(new Set(morning.sources.map(s => s.chatId)).size, morning.sources.length);
const afternoon = await build('2026-10-10T10:00:00Z');
assert.equal(afternoon.todoTargets.length, 0, 'consolidation preserves the once-daily Todo cadence');
assert.equal(JSON.stringify(files), before, 'planning never advances an original success cursor');
files['/todo/a'].lastSuccessfulScanEnd = '2026-10-09T20:01:00Z';
assert.equal((await build('2026-10-09T20:00:00Z')).todoTargets.length, 0, 'a completed morning is not reassessed by a rerun');
files['/todo/a'].pendingRetries = [{ sourceMessageId: 'old-request', threadId: 'old-retry-thread', taskGuid: 'already-created' }];
const retryPlan = await build('2026-10-09T20:00:00Z');
assert.equal(retryPlan.todoTargets.length, 1, 'a success cursor must not hide pending recovery work');
assert.deepEqual(retryPlan.sources[0].requiredMessageIds, ['old-request']);
assert.ok(retryPlan.sources[0].knownThreads.includes('old-retry-thread'));
assert.equal((await build('2026-10-10T10:00:00Z')).todoTargets.length, 0, 'retries do not silently add an afternoon scan');
assert.equal(files['/todo/a'].pendingRetries[0].taskGuid, 'already-created', 'planning preserves the original task receipt');
await assert.rejects(() => build('2026-10-10T12:00:00Z'), /scheduled time/);
await assert.rejects(() => build('2026-10-09T20:00:00Z', { runtime: { ...runtime, enabled: false } }), /disabled/);

const source = { todoTarget: 'a', chatId: 'a', windowStart: '2026-10-09T20:00:00Z', windowEnd: '2026-10-12T20:00:00Z' };
const human = (id, time) => ({ message_id: id, create_time: time, sender: { sender_type: 'user' } });
const index = { chat_id: 'a', messages: [human('first-day', '2026-10-10 04:00'), human('last-day', '2026-10-12 23:00'),
  human('next-window', '2026-10-13 04:00'), { message_id: 'bot', create_time: '2026-10-11 09:00', sender: { sender_type: 'app' } }] };
const decision = ids => ({ sourceMessageIds: ids, disposition: 'no_action', reason: 'A source-based explanation, judged by the Harness.' });
const partial = { actions: [decision(['last-day'])] };
const originalInput = JSON.stringify({ source, index, partial });
const missing = checkTodoCoverage({ source, index, judgments: partial });
assert.equal(missing.coverageComplete, false, 'a 24-hour judgment cannot pass a 72-hour collection window');
assert.deepEqual(missing.missingJudgmentIds, ['first-day']);
assert.equal(missing.requiredMessages, 2, 'the exclusive endpoint and bot messages do not become new human requests');
const complete = { actions: [decision(['first-day', 'last-day'])] };
assert.equal(checkTodoCoverage({ source, index, judgments: complete }).coverageComplete, true);
const retryMissing = checkTodoCoverage({ source: { ...source, requiredMessageIds: ['old-request'] }, index, judgments: complete });
assert.deepEqual(retryMissing.missingSourceIds, ['old-request'], 'a retry outside the window still needs its source');
assert.equal(checkTodoCoverage({ source, index: { ...index, chat_id: 'other' }, judgments: complete }).coverageComplete, false);
assert.equal(checkTodoCoverage({ source, index, judgments: { actions: [{ ...decision(['first-day', 'last-day']), reason: '' }] } }).coverageComplete, false);
assert.equal(checkTodoCoverage({ source, index: { ...index, messages: [human('bad-time', 'unknown')] }, judgments: { actions: [] } }).coverageComplete, false);
assert.equal(checkTodoCoverage({ source, index, judgments: { actions: [decision(['first-day', 'last-day', 'fabricated'])] } }).coverageComplete, false);
assert.equal(JSON.stringify({ source, index, partial }), originalInput, 'coverage checking never changes inputs or cursors');

const candidate = (url, status = 'pending') => ({ candidate: { url, title: 'Candidate', fetched_at: '2026-10-02T00:00:00Z' },
  last_captured_edition: '2026-10-02', status });
const snapshot = { items: { first: candidate('https://example.org/data#one'), second: candidate('https://example.org/data#two'),
  private: candidate('https://example.org/private', 'private_reference_only'), missing: candidate(''),
  internal: candidate('https://127.0.0.1/'), doc: candidate('https://tenant.feishu.cn/docx/private'),
  secret: candidate('https://example.org/download?token=sensitive'), credential: candidate('https://user:pass@example.org/') } };
const original = JSON.stringify(snapshot);
const handoff = researchCandidateHandoff(snapshot, { edition: '2026-10-10', generatedAt: '2026-10-10T00:00:00Z', sourcePath: '/source', sourceSha256: 'sha' });
assert.equal(handoff.candidates.length, 1, 'only public originals are shared, with duplicates merged');
assert.equal(handoff.candidates[0].sources.length, 2, 'both source references survive deduplication');
assert.equal(handoff.candidates[0].sources[0].lastCapturedEdition, '2026-10-02', 'export does not make old material fresh');
assert.equal(handoff.candidates[0].evidenceRole, 'discovery_candidate_only');
assert.equal(JSON.stringify(snapshot), original);
console.log('Shared inspection scope, backlog, cadence and candidate handoff checks passed.');
