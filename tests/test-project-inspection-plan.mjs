import assert from 'node:assert/strict';
import { buildProjectInspectionPlan } from '../scripts/project-inspection-plan.mjs';
import { researchCandidateHandoff } from '../scripts/research-candidate-handoff.mjs';

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
await assert.rejects(() => build('2026-10-10T12:00:00Z'), /scheduled time/);
await assert.rejects(() => build('2026-10-09T20:00:00Z', { runtime: { ...runtime, enabled: false } }), /disabled/);

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
