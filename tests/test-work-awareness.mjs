import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'remotelab-work-'));
setIsolatedTestHome(home);
const config = join(home, '.config', 'remotelab');
await mkdir(config, { recursive: true });
await writeFile(join(config, 'auth.json'), JSON.stringify({ version: 2, primaryPersonId: 'person_a', people: [
  { id: 'person_a', name: '甲', identities: [{ id: 'identity_a', kind: 'web', subjectId: 'a' }] },
  { id: 'person_b', name: '乙', identities: [{ id: 'identity_b', kind: 'web', subjectId: 'b' }] },
] }));
await writeFile(join(config, 'chat-sessions.json'), JSON.stringify(['a', 'b'].map(id => ({ id, name: id, folder: home }))));
try {
  const { loadAuthDocument } = await import('../lib/auth-config.mjs');
  await loadAuthDocument({ persistMigration: false });
  const m = await import('../chat/work-awareness.mjs');
  const { findSessionMeta, mutateSessionMeta } = await import('../chat/session-meta-store.mjs');
  const actorA = m.verifiedWorkActor('person_a', 'identity_a');
  const actorB = m.verifiedWorkActor('person_b', 'identity_b');
  assert.equal(m.verifiedWorkActor('person_a', 'identity_b'), null);
  assert.equal(m.verifiedWorkActor(undefined, undefined), null);
  const goal = '修改同一份开工流程中的人物身份读取';
  assert.deepEqual(await m.queryRelatedWork({ sessionId: 'a', query: goal }), []);
  assert.deepEqual(await m.queryRelatedWork({ sessionId: 'b', query: goal }), []);
  const start = performance.now();
  const [a, b] = await Promise.all([
    m.startWork({ sessionId: 'a', requestId: 'a1', actor: actorA, goal, object: 'startup.md', projectId: 'example' }),
    m.startWork({ sessionId: 'b', requestId: 'b1', actor: actorB, goal, object: 'startup.md', projectId: 'example' }),
  ]);
  assert.equal(a.work.status, 'active'); assert.equal(b.work.status, 'active');
  assert.equal(a.work.projects[0].status, 'candidate');
  assert.equal((await m.queryRelatedWork({ sessionId: 'a', query: goal }))[0].sessionId, 'b');
  assert.equal((await m.queryRelatedWork({ sessionId: 'b', query: goal }))[0].sessionId, 'a');
  const suggest = await m.createWorkSuggestion({ sessionId: 'a', targetSessionId: 'b', actor: actorA, requestId: 's1',
    sourceWorkId: a.work.id, targetWorkId: b.work.id, content: '发现双方在修改同一段，建议一起核对。', impact: '可能减少重复修改', evidenceRefs: [a.eventSeq] });
  const sid = suggest.suggestion.id;
  assert.equal((await m.workInbox('b')).length, 0, 'draft is not sent to the destination');
  await assert.rejects(m.decideWorkSuggestion({ sessionId: 'b', suggestionId: sid, action: 'publish', actor: actorB, requestId: 'wrong' }), /belongs/);
  const pub = await m.decideWorkSuggestion({ sessionId: 'a', suggestionId: sid, action: 'publish', actor: actorA, requestId: 'human-publish' });
  assert.equal(pub.referenceDelivery.state, 'published');
  const duplicate = await m.decideWorkSuggestion({ sessionId: 'a', suggestionId: sid, action: 'publish', actor: actorA, requestId: 'human-publish' });
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.referenceDelivery, undefined);
  assert.equal((await m.workInbox('b'))[0].state, 'published');
  const before = (await findSessionMeta('b')).workAwareness.works[0];
  assert.equal(before.version, 1); assert.equal(before.goal, goal, 'publication does not change the receiving task');
  assert.equal((await m.queryRelatedWork({ sessionId: 'b', query: goal }))[0].authority, 'reference-only');
  const approve = await m.decideWorkSuggestion({ sessionId: 'b', suggestionId: sid, action: 'approve', actor: actorB, requestId: 'human-approve' });
  assert.equal(approve.suggestion.state, 'approved');
  assert.equal((await findSessionMeta('b')).workAwareness.works[0].version, 1, 'approval and execution are separate');
  await m.updateWork({ sessionId: 'b', workId: b.work.id, expectedVersion: 1, actor: actorB, status: 'completed', result: '修改完成并有源证据', evidenceRefs: [b.eventSeq], artifacts: ['startup.md'], methods: ['skills/startup/SKILL.md'] });
  const result = (await m.queryRelatedWork({ sessionId: 'a', query: goal }))[0];
  assert.equal(result.status, 'completed'); assert.equal(result.results.at(-1).artifacts[0], 'startup.md');
  const reuse = await m.createWorkSuggestion({ sessionId: 'b', targetSessionId: 'a', actor: actorB, requestId: 'reuse-result',
    sourceWorkId: b.work.id, targetWorkId: a.work.id, content: '已完成工作中的方法可以作为复用参考', impact: '仍需核对当前适用条件', evidenceRefs: [b.eventSeq] });
  assert.equal(reuse.suggestion.state, 'draft', 'a completed source can provide reusable experience');
  await assert.rejects(m.updateWork({ sessionId: 'b', workId: b.work.id, expectedVersion: 1, status: 'active', evidenceRefs: [b.eventSeq] }), /changed/);
  const pending = await m.createWorkSuggestion({ sessionId: 'a', targetSessionId: 'b', actor: actorA, requestId: 's2', content: '参考新事实', impact: '待核对', evidenceRefs: [a.eventSeq] });
  await mutateSessionMeta('b', session => { session.archived = true; return true; });
  await assert.rejects(m.decideWorkSuggestion({ sessionId: 'a', suggestionId: pending.suggestion.id, action: 'publish', actor: actorA, requestId: 'stale' }), /archived/);
  await m.decideWorkSuggestion({ sessionId: 'a', suggestionId: pending.suggestion.id, action: 'reject', actor: actorA, requestId: 'reject' });
  const stored = JSON.parse(await readFile(join(config, 'chat-sessions.json'), 'utf8'));
  assert.equal(stored.find(session => session.id === 'a').workAwareness.suggestions[0].state, 'approved');
  const newRoute = await m.createWorkSuggestion({ sessionId: 'a', actor: actorA, requestId: 'new-route', sourceWorkId: a.work.id,
    purpose: 'routing', content: '新开 Session 的建议', impact: '改执行目的地，需核验', evidenceRefs: [a.eventSeq],
    routing: { mode: 'new-session', task: '限定的另一条路线' } });
  assert.equal(newRoute.suggestion.targetSessionId, '');
  await m.updateWork({ sessionId: 'a', workId: a.work.id, expectedVersion: 1, actor: actorA, status: 'active', result: '范围已变', evidenceRefs: [a.eventSeq] });
  await assert.rejects(m.decideWorkSuggestion({ sessionId: 'a', suggestionId: newRoute.suggestion.id, action: 'publish', actor: actorA, requestId: 'stale-new-route' }), /changed/);
  await m.recordWorkInput(await findSessionMeta('a'), { requestId: 'ongoing-input', runId: 'run_example', text: goal, options: { viewPersonId: 'person_a', initiatedByIdentityId: 'identity_a' } });
  await m.recordWorkOutcome('a', { requestId: 'ongoing-input', responseId: 'response_example', options: {}, result: { payload: { text: '产出报告' } } }, { id: 'run_example', state: 'completed' });
  assert.equal((await findSessionMeta('a')).workAwareness.intents.at(-1).outcome.businessAcceptance, 'not-asserted');
  assert.equal((await findSessionMeta('a')).workAwareness.works[0].status, 'active', 'a finished Run is not accepted business completion');
  const routing = await m.createWorkSuggestion({ sessionId: 'a', actor: actorA, requestId: 'approved-route', purpose: 'routing',
    content: '新开一个独立 Session', impact: '新目的地及任务已给人检查', evidenceRefs: [a.eventSeq], routing: { mode: 'new-session', task: '核对具体第二条路线' } });
  assert.match(routing.confirmation, /执行$/);
  assert.equal((await m.decideWorkSuggestion({ sessionId: 'a', suggestionId: routing.suggestion.id, action: 'approve', actor: actorA, requestId: 'route-human' })).suggestion.state, 'approved');
  const fixture = Array.from({ length: 1000 }, (_, index) => ({ id: 'benchmark_' + index, name: '测试 ' + index, folder: home,
    workAwareness: { version: 1, revision: 1, works: [], suggestions: [], intents: [] },
    workSummary: { goal: index % 20 ? '整理其他资料 ' + index : goal } }));
  const samples = [];
  for (let i = 0; i < 20; i++) {
    const begin = performance.now();
    const matches = m.candidateWorkFromSessions(fixture, { sessionId: 'benchmark_0', query: goal, limit: 3 });
    samples.push(performance.now() - begin);
    assert.equal(matches.length, 3);
  }
  samples.sort((a, b) => a - b);
  console.log(JSON.stringify({ measurement: '1000 synthetic Session records, metadata only', samples: 20, p50Ms: samples[10], p95Ms: samples[18] }));
  console.log('WORK_VERIFIED: simultaneous starts remain active; both find overlap; draft/publish/adopt are distinct; stale decisions rejected; results and methods retained; persisted canonical Session state. Elapsed ms=' + Math.round(performance.now() - start));
} finally { await rm(home, { recursive: true, force: true }); }
