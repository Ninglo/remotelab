import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const home = await mkdtemp(join(tmpdir(), 'personal-memory-conversation-'));
setIsolatedTestHome(home);
process.env.REMOTELAB_MEMORY_DIR = join(home, 'memory');
try {
  const { loadAuthDocument, updateAuthDocument } = await import('../lib/auth-config.mjs');
  await updateAuthDocument(doc => {
    doc.people = ['alice', 'bob'].map(name => ({ id: `person_${name}`, name, credentials: [],
      preferences: { unrelated: name }, identities: ['web', 'feishu'].map(kind => ({
        id: `${kind}_${name}`, kind, realm: 'fixture', subjectId: name })) }));
    doc.primaryPersonId = 'person_alice';
  });
  const memoryDir = process.env.REMOTELAB_MEMORY_DIR;
  await mkdir(memoryDir, { recursive: true });
  await writeFile(join(memoryDir, 'learning-policy.json'), JSON.stringify({ version: 1, enabled: true,
    profiles: true, handbook: true, context: true, personIds: ['person_alice'] }));
  const { loadPersonalMemorySettings: load, changePersonalMemorySettings: change } = await import('../chat/personal-memory-settings.mjs');
  const { buildTurnContextHook } = await import('../chat/turn-context-hook.mjs');
  const { MEMORY_ABSTRACTION_GUIDANCE } = await import('../chat/memory-abstraction.mjs');
  const { handlePersonalMemorySettings: handle } = await import('../chat/router-personal-memory-settings.mjs');
  const m = await import('../chat/memory-learning.mjs');
  const actor = { personId: 'person_alice', identityId: 'web_alice' };
  const bob = { personId: 'person_bob', identityId: 'web_bob' };
  assert.equal((await load(actor)).conversational, false);
  assert.equal((await load(bob)).available, false);
  await assert.rejects(change({ enabled: true, confirm: true, expectedRevision: 0 }, bob), /试点/);
  await assert.rejects(load({ ...actor, identityId: 'web_bob' }), /本人/);
  await assert.rejects(load({ ...actor, authKind: 'service' }), /本人/);
  const saved = await change({ enabled: true, confirm: true, expectedRevision: 0 }, actor);
  assert.equal(saved.revision, 1);
  assert.deepEqual(await load(actor), saved);
  const { mayReviewGroupPersonalMemory } = await import('../chat/personal-memory-settings.mjs');
  const groupInput = { viewPersonId: actor.personId, initiatedByIdentityId: 'feishu_alice', feishuConnectorAuthenticated: true,
    sourceContext: { connector: 'feishu', chatType: 'group', sender: { senderType: 'user' } } };
  assert.equal(await mayReviewGroupPersonalMemory(groupInput), true);
  for (const override of [{ viewPersonId: bob.personId, initiatedByIdentityId: 'feishu_bob' }, { recordUserMessage: false },
    { internalOperation: true }, { feishuConnectorAuthenticated: false }, { sourceContext: { connector: 'feishu', chatType: 'group', sender: { senderType: 'bot' } } }]) {
    assert.equal(await mayReviewGroupPersonalMemory({ ...groupInput, ...override }), false);
  }

  await assert.rejects(change({ enabled: false, confirm: true, expectedRevision: 0 }, actor), /已更新/);
  for (const surface of ['web', 'p2p', 'group', 'thread']) {
    const context = await buildTurnContextHook({}, { ...actor,
      identityId: surface === 'web' ? actor.identityId : 'feishu_alice',
      sourceContext: surface === 'web' ? undefined : { connector: 'feishu', chatType: surface === 'p2p' ? 'p2p' : 'group',
        conversationKind: surface === 'thread' ? 'thread' : 'main', sender: { senderType: 'user' } } });
    assert.match(context, /Personal memory conversation trial is enabled/, surface);
    assert(!context.includes(MEMORY_ABSTRACTION_GUIDANCE), `${surface}: detailed examples stay on demand`);
    assert.match(context, /docs\/memory-learning\.md/);
    assert(context.length < 2200, `${surface}: ordinary learning context remains compact`);
    assert.doesNotMatch(context, /BETA_SECRET|\[object Object\]/);
  }
  const split = await buildTurnContextHook({}, { ...actor, separateProjectContext: true });
  assert.match(split.personalMemory, /Personal memory conversation trial/);
  assert.doesNotMatch(split.text, /Personal memory conversation trial|Synthetic contrasts/);
  assert.equal((await buildTurnContextHook({}, { ...bob, separateProjectContext: true })).personalMemory, '');
  assert.doesNotMatch(await buildTurnContextHook({}, bob), /Personal memory conversation trial/);
  assert.doesNotMatch(await buildTurnContextHook({}, { ...actor, experimentInput: { automated: true } }), /Personal memory conversation trial/);
  assert.doesNotMatch(await buildTurnContextHook({}, { ...actor, sourceContext: { sender: { senderType: 'bot' } } }), /Personal memory conversation trial/);
  const sources = (sessionId, quote) => m.learningTurnEvidence({ sessionId, runId: `run_${sessionId}`,
    userMessage: quote, sourceEventSeq: 1, turnEvents: [] });
  const apply = async (updates, quote, sessionId = 'one') => m.applyLearningUpdates({ ...actor, memoryDir,
    authDocument: await loadAuthDocument({ persistMigration: false }), updates, sources: sources(sessionId, quote) });
  const inspect = async () => m.inspectLearning({ ...actor, memoryDir, authDocument: await loadAuthDocument({ persistMigration: false }) });
  const habit = { key: 'familiar-example', kind: 'habit', content: '解释陌生概念时先联系熟悉的例子。',
    conditions: '解释陌生概念时', exceptions: '', cues: ['解释'], evidence: [{ seq: 1, quote: '请联系熟悉的例子' }] };
  await apply([habit], '请联系熟悉的例子');
  const entry = (await inspect()).profile.entries[0];
  const propose = { key: habit.key, kind: 'habit', action: 'propose', expectedVersion: entry.version,
    question: '我观察到你理解新概念时偏好熟悉的例子，要不要记住？', evidence: habit.evidence };
  const attempts = await Promise.all([apply([propose], '请联系熟悉的例子', 'two'), apply([propose], '请联系熟悉的例子', 'three')]);
  assert.equal(attempts.reduce((n, r) => n + r.promotedCount, 0), 1, 'concurrent questions cannot both be claimed');
  let pending = (await inspect()).profile.entries[0];
  assert.equal(pending.reviewProposal.status, 'pending');
  assert.equal(pending.status, 'observed', 'a question is not acceptance');
  assert.equal(pending.reviewProposal.content, habit.content);
  assert.equal((await apply([{ ...propose, expectedVersion: pending.version }], '请联系熟悉的例子', 'four')).promotedCount, 0);
  assert.equal((await apply([{ ...habit, action: 'revise', expectedVersion: pending.version, content: '不要技术细节' }], '请联系熟悉的例子')).promotedCount, 0, 'pending meaning cannot be silently rewritten');
  await apply([{ ...habit, kind: 'preference', action: 'revise', expectedVersion: pending.version, explicit: true,
    evidence: [{ seq: 1, quote: '把先联系熟悉例子这点记为我今后的偏好' }] }], '把先联系熟悉例子这点记为我今后的偏好');
  pending = (await inspect()).profile.entries[0];
  assert.equal(pending.status, 'confirmed');
  assert.equal(pending.reviewProposal.status, 'confirmed');
  // A natural correction can be proposed after one source session. The nearby
  // accepted Feishu-only preference must not be widened or treated as consent.
  const narrow = { key: 'feishu-permissions', kind: 'preference', explicit: true,
    content: '已授权的飞书任务中，自行处理可解决的权限问题。', conditions: '飞书权限问题',
    cues: ['权限'], evidence: [{ seq: 1, quote: '以后飞书权限能自己处理的就自己处理' }] };
  await apply([narrow], narrow.evidence[0].quote, 'narrow');
  const correction = '你能处理的就都处理掉，强调很多次了，需要帮助的时候叫我';
  const initiative = { key: 'authorized-work-initiative', kind: 'habit', explicit: false,
    content: '在已授权工作中主动完成能处理的步骤，确需本人帮助或决定时再询问。',
    conditions: '已授权工作中的执行和求助方式；额外范围待本人确认',
    exceptions: '不新增业务授权，不绕过必须由本人决定的事项', cues: ['主动推进'],
    reason: '关联 feishu-permissions，但当前信号超出其飞书限定，保留原确认项。',
    evidence: [{ seq: 1, quote: correction }] };
  assert.equal((await apply([initiative], correction, 'natural-correction')).promotedCount, 1);
  let candidate = (await inspect()).profile.entries.find(e => e.key === initiative.key);
  assert.equal(candidate.status, 'observed');
  assert.equal(new Set(candidate.evidence.map(e => e.sessionId)).size, 1);
  assert.equal((await apply([{ key: candidate.key, kind: 'habit', action: 'propose',
    expectedVersion: candidate.version, question: '我观察到你希望已授权工作主动推进，确需你帮助时再问，要记为长期协作习惯吗？',
    evidence: initiative.evidence }], correction, 'natural-correction')).promotedCount, 1);
  const afterCorrection = (await inspect()).profile.entries;
  candidate = afterCorrection.find(e => e.key === initiative.key);
  assert.equal(candidate.status, 'observed');
  assert.equal(candidate.reviewProposal.status, 'pending');
  assert.equal(afterCorrection.find(e => e.key === narrow.key).content, narrow.content);
  assert.equal(afterCorrection.find(e => e.key === narrow.key).conditions, narrow.conditions);
  // Only this speaker's successful personal background writes in this topic
  // are offered. Context projection is an opportunity, never delivery proof.
  const { selectRecentMemoryFeedback: select } = await import('../chat/personal-memory-conversation.mjs');
  const { appendEvent } = await import('../chat/history.mjs');
  const notice = { type: 'context_operation', operation: 'write_memory', phase: 'applied', trigger: 'automatic',
    learningOwnerPersonId: actor.personId, learningSourceEventSeq: 1,
    learningResults: [{ changed: true, path: `${memoryDir}/reference/people/person_alice.md`,
      id: 'mem_0123456789abcdef', version: 1, status: 'confirmed' }] };
  assert.equal(select([notice], actor.personId).length, 1);
  assert.equal(select([notice], bob.personId).length, 0);
  assert.equal(select([{ ...notice, learningResults: [{ ...notice.learningResults[0], status: 'observed' }] }], actor.personId).length, 0);
  assert.equal(select([{ ...notice, phase: 'rejected' }], actor.personId).length, 0);
  assert.equal(select([{ ...notice, learningOwnerPersonId: undefined }], actor.personId).length, 0);
  assert.equal(select([{ ...notice, learningResults: [{ ...notice.learningResults[0], path: '/agent-handbook.md' }] }], actor.personId).length, 0);
  assert.equal(select([notice, { type: 'manager_context' }], actor.personId).length, 0);
  const updatedNotice = { ...notice, learningResults: [{ ...notice.learningResults[0], version: 2, status: 'withdrawn' }] };
  assert.equal(select([notice, updatedNotice], actor.personId)[0].version, 2);
  await appendEvent('memory-feedback-fixture', notice);
  const feedbackContext = await buildTurnContextHook({ id: 'memory-feedback-fixture' }, actor);
  assert.match(feedbackContext, /Background memory writes/);
  const feedbackSplit = await buildTurnContextHook({ id: 'memory-feedback-fixture' }, { ...actor, separateProjectContext: true });
  assert.match(feedbackSplit.text, /Background memory writes/);
  assert.doesNotMatch(feedbackSplit.personalMemory, /mem_0123456789abcdef/);

  assert.match(feedbackContext, /mem_0123456789abcdef/);
  assert.doesNotMatch(feedbackContext, /解释陌生概念/);
  await appendEvent('memory-feedback-fixture', { type: 'manager_context', content: feedbackContext });
  assert.doesNotMatch(await buildTurnContextHook({ id: 'memory-feedback-fixture' }, actor), /Background memory writes/);
  await change({ enabled: false, confirm: true, expectedRevision: saved.revision }, actor);
  assert.match(await buildTurnContextHook({}, actor), /Personal memory is paused/);
  assert.equal(await mayReviewGroupPersonalMemory(groupInput), false);
  assert.equal((await apply([{ ...habit, key: 'new-pattern' }], '请联系熟悉的例子')).promotedCount, 0);
  assert.doesNotMatch(await m.buildLearningContext({ ...actor, memoryDir, query: '解释', authDocument: await loadAuthDocument({ persistMigration: false }) }), /解释陌生概念时先联系/);
  assert.equal((await inspect()).profile.entries[0].status, 'confirmed', 'pause retains stored records');
  const doc = await loadAuthDocument({ persistMigration: false });
  assert.equal(doc.people.find(p => p.id === bob.personId).preferences.personalMemory, undefined);
  assert.equal(doc.people.find(p => p.id === actor.personId).preferences.unrelated, 'alice');
  const call = async (body, authSession = actor) => {
    let response;
    await handle({ pathname: '/api/personal-memory-settings', req: Object.assign(Readable.from([JSON.stringify(body)]), { method: 'POST' }),
      res: {}, authSession, writeJson: (_res, code, data) => { response = { code, data }; } });
    return response;
  };
  assert.equal((await call({ enabled: true, expectedRevision: 2, confirm: true, personId: bob.personId })).code, 400);
  assert.equal((await call({ enabled: true, expectedRevision: 2, confirm: true }, { ...actor, authKind: 'service' })).code, 403);
  assert.equal((await call({ enabled: true, expectedRevision: 2, confirm: true })).code, 200);
  assert.equal((await load(actor)).enabled, true);
  const { requests } = await import('../chat/requests.mjs');
  const accepted = (await requests.accept({ sessionId: 'memory-fixture', requestId: 'human-opt-out', text: '停用个人记忆',
    options: { viewPersonId: actor.personId, initiatedByIdentityId: actor.identityId } })).record;
  let runResponse;
  await handle({ pathname: '/api/personal-memory-settings/current-run', parsedUrl: { query: {} },
    req: Object.assign(Readable.from([JSON.stringify({ runId: accepted.runId, enabled: false, confirm: true, expectedRevision: 3 })]), { method: 'POST' }),
    res: {}, authSession: { authKind: 'service' }, writeJson: (_res, code, data) => { runResponse = { code, data }; } });
  assert.equal(runResponse.code, 200, JSON.stringify(runResponse));
  assert.equal((await load(actor)).enabled, false);
  const template = await readFile(new URL('../templates/chat.html', import.meta.url), 'utf8');
  assert.match(template, /id="personalMemoryToggle"[^>]*>启用个人记忆/);
  console.log('PERSONAL_MEMORY_CONVERSATION_VERIFIED: own settings persist; all four human surfaces; other people, bots and automated work excluded; pause blocks learning/retrieval; concurrent proposals deduplicate without consent; explicit confirmation resolves; API rejects impersonation.');
} finally { await rm(home, { recursive: true, force: true }); }
