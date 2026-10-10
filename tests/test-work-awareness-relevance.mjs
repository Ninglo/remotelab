import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
import { candidateWorkFromSessions, relatedWorkFromSessions, workSearchEntries } from '../chat/work-awareness-relevance.mjs';

const fixture = [
  { id: 'a', workSummary: { goal: '优化 RemoteLab 相关工作检索，减少误推荐' }, workAwareness: { works: [], intents: [{ requestId: 'a1', goal: '继续吧' }] } },
  { id: 'startup', name: 'Session 开工功能', updatedAt: '2026-10-06T09:00:00Z', lastReviewedAt: '2026-10-08T09:00:00Z',
    workSummary: { goal: '实现 RemoteLab 开工登记和相关工作检索', summary: '已有实现可查', rawMaterials: ['chat/work-awareness.mjs'] } },
  { id: 'meeting', name: '会议权限', workSummary: { goal: '获取飞书会议纪要的文字权限' }, workAwareness: { intents: [{ goal: '然后看一下，这里的问题我觉得确实需要考虑' }] } },
  { id: 'industry', name: 'AI 行业', workSummary: { goal: '建立 AI 行业资讯赛道' }, workAwareness: { intents: [{ goal: '这是相关的行业内容，但是我觉得确实要看一下' }] } },
  { id: 'raw', workAwareness: { intents: [{ goal: '优化 RemoteLab 相关工作检索，减少误推荐' }] } },
  { id: 'semantic', workSummary: { goal: '查重提示的判断依据与交叉检查' } },
];
const hits = candidateWorkFromSessions(fixture, { sessionId: 'a' });
assert(hits.some(hit => hit.sessionId === 'startup'), 'stable task survives a short follow-up');
assert(!hits.some(hit => ['meeting', 'industry', 'raw'].includes(hit.sessionId)), 'generic overlap and unclassified messages are not indexed tasks');
assert.deepEqual(relatedWorkFromSessions(fixture, { sessionId: 'a' }), [], 'even a good keyword candidate needs a relevance review');
assert.deepEqual(relatedWorkFromSessions(fixture, { sessionId: 'unknown', query: '然后我觉得相关的问题确实需要看一下' }), [], 'no minimum recommendation count');
assert.equal(workSearchEntries(fixture).find(entry => entry.sessionId === 'startup').status, 'recorded', 'an inferred summary is not completion acceptance');
const deviceFixture = [
  { id: 'fresh', workAwareness: { works: [], intents: [], suggestions: [] } },
  { id: 'display', name: '副屏内容', workSummary: { goal: '副屏采用工作、提醒、陪伴三区', summary: '已有设置入口' } },
  { id: 'other', name: '其他工作', workSummary: { goal: '配置通知投递' } },
  { id: 'recording', name: '多电脑录音接入', workSummary: { goal: 'Mac Mini 连接电脑后显示录音内容' } },
];
assert(candidateWorkFromSessions(deviceFixture, { sessionId: 'fresh', query: '副屏' }).some(hit => hit.sessionId === 'display'),
  'one explicit named topic is sufficient for a reference candidate');
assert.deepEqual(relatedWorkFromSessions(deviceFixture, { sessionId: 'fresh', query: '副屏' }), [],
  'a topic match remains unreviewed rather than automatic association');
assert.equal(candidateWorkFromSessions(deviceFixture, { sessionId: 'fresh',
  query: '副屏现在连接在Mac Mini上了，但是我希望它能显示我这台电脑的内容，能做到吗' })[0].sessionId, 'display',
  'the named display topic outranks an unrelated task on the same computer');
assert(candidateWorkFromSessions(fixture, { sessionId: 'a', query: '继续吧' }).some(hit => hit.sessionId === 'startup'),
  'generic continuation retains the existing goal');

assert.equal(workSearchEntries(fixture).find(entry => entry.sessionId === 'startup').updatedAt, fixture[1].updatedAt,
  'viewing an old source cannot make its record appear newly updated');

const home = await mkdtemp(join(tmpdir(), 'remotelab-relevance-'));
setIsolatedTestHome(home);
const config = join(home, '.config/remotelab');
await mkdir(config, { recursive: true });
await writeFile(join(config, 'chat-sessions.json'), JSON.stringify(fixture));
try {
  const m = await import('../chat/work-awareness.mjs');
  await writeFile(join(config, 'chat-sessions.json'), JSON.stringify(deviceFixture));
  const candidates = await m.queryWorkCandidates({ sessionId: 'fresh', query: '副屏' });
  assert.equal(candidates[0].sessionId, 'display', 'explicit retrieval still finds a named topic without an old summary');
  await writeFile(join(config, 'chat-sessions.json'), JSON.stringify(fixture));
  const { mutateSessionMeta } = await import('../chat/session-meta-store.mjs');
  const actor = { personId: 'person_a', identityId: 'identity_a', name: '甲' };
  const item = { sessionId: hits[0].sessionId, workId: hits[0].id, fingerprint: hits[0].fingerprint,
    relation: 'reuse', reason: '昨天实现的相关工作检索及其测试，是本轮调整误推荐的直接修改依据。' };
  await m.reviewRelatedWork({ sessionId: 'a', requestId: 'a1', runId: 'run_a', actor, items: [item], evidenceRefs: [1] });
  const related = await m.queryRelatedWork({ sessionId: 'a' });
  assert.equal(related.length, 1); assert.equal(related[0].verification, 'harness-reviewed');
  assert.equal(related[0].reason, item.reason); assert.equal(related[0].authority, 'reference-only');
  await assert.rejects(m.reviewRelatedWork({ sessionId: 'a', requestId: 'a1', actor, items: [{ ...item, reason: '有关' }], evidenceRefs: [1] }), /Explain/);
  await assert.rejects(m.reviewRelatedWork({ sessionId: 'a', requestId: 'old-request', actor, items: [item], evidenceRefs: [1] }), /input changed/);
  await mutateSessionMeta('startup', session => { session.workSummary.goal = '已经改为另一个目标'; return true; });
  assert.deepEqual(await m.queryRelatedWork({ sessionId: 'a' }), [], 'changed target invalidates a prior review');
  await assert.rejects(m.reviewRelatedWork({ sessionId: 'a', requestId: 'a1', actor, items: [item], evidenceRefs: [1] }), /work changed/);
  const noWordsInCommon = { sessionId: 'semantic', workId: 'summary_semantic',
    fingerprint: workSearchEntries([fixture[5]])[0].fingerprint, relation: 'reuse',
    reason: '此来源中的查重判断方案，可以用于当前任务核对误推荐的判定依据。' };
  await m.reviewRelatedWork({ sessionId: 'a', requestId: 'a1', actor, items: [noWordsInCommon], evidenceRefs: [1] });
  assert.equal((await m.queryRelatedWork({ sessionId: 'a' }))[0].sessionId, 'semantic', 'Harness can record a sourced semantic relation without keyword overlap');
  await mutateSessionMeta('a', session => { session.workAwareness.intents.push({ requestId: 'a2', goal: '新的需求' }); return true; });
  assert.deepEqual(await m.queryRelatedWork({ sessionId: 'a' }), [], 'new human input requires fresh judgment');
  await m.reviewRelatedWork({ sessionId: 'a', requestId: 'a2', actor, items: [], evidenceRefs: [1] });
  assert.deepEqual(await m.queryRelatedWork({ sessionId: 'a' }), [], 'an empty review is valid');
  console.log('RELEVANCE_VERIFIED: stable goals, actual false-positive examples, candidate/display separation, explicit reasons, semantic relation writeback, stale-target and new-input invalidation, and empty results.');
} finally { await rm(home, { recursive: true, force: true }); }
