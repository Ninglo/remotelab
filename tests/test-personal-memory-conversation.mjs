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
  await assert.rejects(change({ enabled: false, confirm: true, expectedRevision: 0 }, actor), /已更新/);
  for (const surface of ['web', 'p2p', 'group', 'thread']) {
    const context = await buildTurnContextHook({}, { ...actor,
      identityId: surface === 'web' ? actor.identityId : 'feishu_alice',
      sourceContext: surface === 'web' ? undefined : { connector: 'feishu', chatType: surface === 'p2p' ? 'p2p' : 'group',
        conversationKind: surface === 'thread' ? 'thread' : 'main', sender: { senderType: 'user' } } });
    assert.match(context, /Personal memory conversation trial is enabled/, surface);
    assert.doesNotMatch(context, /BETA_SECRET/);
  }
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
  await change({ enabled: false, confirm: true, expectedRevision: saved.revision }, actor);
  assert.match(await buildTurnContextHook({}, actor), /Personal memory is paused/);
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
