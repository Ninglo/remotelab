import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'remotelab-learning-'));
setIsolatedTestHome(home);
process.env.REMOTELAB_MEMORY_DIR = join(home, 'memory');
process.env.REMOTELAB_CONFIG_DIR = join(home, 'config');
const m = await import('../chat/memory-learning.mjs');
const { maybeRunMemoryWriteback } = await import('../chat/session-memory-writeback.mjs');
const memoryDir = process.env.REMOTELAB_MEMORY_DIR;
const authDocument = { people: [
  { id: 'person_alpha', identities: [{ id: 'identity_alpha', kind: 'web', subjectId: 'alpha' }] },
  { id: 'person_beta', identities: [{ id: 'identity_beta', kind: 'web', subjectId: 'beta' }] },
] };
const actor = { personId: 'person_alpha', identityId: 'identity_alpha', authDocument, memoryDir };
const policy = { version: 1, enabled: true, profiles: true, handbook: true, context: true, personIds: ['person_alpha'] };
const policyPath = join(memoryDir, 'learning-policy.json');
const paths = m.learningPaths(memoryDir, actor.personId);
const sources = (sessionId, userMessage, output = '', exitCode = 0) => m.learningTurnEvidence({
  sessionId, runId: `run_${sessionId}`, userMessage, sourceEventSeq: 1,
  turnEvents: output ? [{ type: 'tool_result', runId: `run_${sessionId}`, seq: 2, output, exitCode }] : [],
});
const apply = (updates, src, extra = {}) => m.applyLearningUpdates({ ...actor, updates, sources: src, ...extra });
const snapshot = () => m.inspectLearning(actor);
const context = (query = '请解释', extra = {}) => m.buildLearningContext({ ...actor, query, ...extra });
try {
  await mkdir(join(memoryDir, 'reference', 'people'), { recursive: true });
  await writeFile(paths.profile, '# Alpha\n\n人工维护的称呼偏好：使用全名。\n');
  await writeFile(join(memoryDir, 'reference', 'people', 'person_beta.md'), 'BETA_SECRET');
  const habit = { key: 'plain-language', kind: 'habit', content: '解释时倾向于大白话和具体例子。',
    cues: ['解释', '方案'], conditions: '解释方案时', exceptions: '需要精确术语或当前另有要求时按任务处理',
    evidence: [{ seq: 1, quote: '用大白话解释' }] };
  assert.equal((await apply([habit], sources('s1', '用大白话解释'))).promotedCount, 0);
  assert.equal(await context(), '');
  await writeFile(policyPath, JSON.stringify(policy));
  for (const bad of [{ personId: 'person_beta' }, { identityId: 'identity_beta' }, { personId: '../person_alpha' }, { personId: 'person_system', identityId: 'identity_system' }]) {
    assert.equal((await apply([habit], sources('s1', '用大白话解释'), bad)).promotedCount, 0);
    assert.equal(await context('解释', bad), '');
  }
  let result = await apply([habit], sources('s1', '用大白话解释'));
  assert.equal(result.results[0].status, 'observed');
  assert.doesNotMatch(await context(), /plain-language|倾向于大白话/);
  let entry = (await snapshot()).profile.entries[0];
  result = await apply([{ ...habit, expectedVersion: entry.version }], sources('s1', '用大白话解释'));
  assert.equal(result.promotedCount, 0, 'same original event is idempotent');
  result = await apply([{ ...habit, expectedVersion: entry.version }], sources('s1', '用大白话解释').map(e => ({ ...e, runId: 'run_same_session_2' })));
  entry = (await snapshot()).profile.entries[0];
  assert.equal(entry.status, 'observed', 'many corrections in one Session are not independent observations');
  for (const sessionId of ['s2', 's3']) {
    await apply([{ ...habit, expectedVersion: entry.version }], sources(sessionId, '用大白话解释'));
    entry = (await snapshot()).profile.entries[0];
  }
  assert.equal(entry.status, 'inferred');
  assert.match(await context(), /inferred.*大白话/);
  assert.doesNotMatch(await context(), /BETA_SECRET/);
  assert.doesNotMatch(await context('下载文件'), /倾向于大白话/);
  const narrowed = await apply([{ ...habit, action: 'revise', expectedVersion: entry.version,
    content: '只在方案入门解释时倾向于具体例子。', conditions: '方案入门解释时',
    evidence: [{ seq: 1, quote: '这次先用例子，技术细节用公式' }] }], sources('narrow', '这次先用例子，技术细节用公式'));
  assert.equal(narrowed.results[0].status, 'observed', 'Agent can refine observations, but old support cannot certify a changed claim');
  entry = (await snapshot()).profile.entries[0];
  assert.equal(entry.evidence.length, 1);
  assert.equal(entry.history.at(-1).supportingEvidence.length, 4);
  assert.equal(entry.history.at(-1).conditions, '解释方案时');
  assert.equal(await context('解释', { maxChars: 100 }), '', 'bounded context never clips exceptions off an entry');
  // Explicit default can upgrade the same semantic entry; it does not create a
  // second key or require a long assistant response to be noticed.
  let promptCalls = 0;
  result = await maybeRunMemoryWriteback({ ...actor, sessionId: 'explicit', session: {}, run: { id: 'run_explicit' },
    userMessage: '以后解释都用大白话解释', sourceEventSeq: 1, assistantTurnText: '收到。', turnEvents: [],
    runPrompt: async prompt => {
      promptCalls += 1;
      assert.match(prompt, /same Session|one independent observation/);
      assert.match(prompt, /plain-language/);
      return `<hide>${JSON.stringify({ updates: [{ ...habit, kind: 'preference', action: 'revise',
        expectedVersion: entry.version, explicit: true, reason: '本人明确长期偏好' }] })}</hide>`;
    },
  });
  assert.equal(promptCalls, 1, 'reuse the one reviewer; do not also invoke legacy writeback');
  assert.equal(result.promotedCount, 1);
  entry = (await snapshot()).profile.entries[0];
  assert.equal(entry.status, 'confirmed');
  assert.equal((await snapshot()).profile.entries.length, 1);
  assert.match(await readFile(paths.profile, 'utf8'), /人工维护的称呼偏好/);
  const candidateResult = await maybeRunMemoryWriteback({ ...actor, sessionId: 'decision', session: {}, run: { id: 'run_decision' },
    userMessage: '项目已决定采用格式 A', sourceEventSeq: 1, assistantTurnText: '收到。', turnEvents: [],
    runPrompt: async prompt => {
      promptCalls += 1;
      assert.match(prompt, /Existing candidate targets:/);
      return '<hide>{"updates":[],"shouldWrite":true,"learnings":[{"category":"decision","content":"项目采用格式 A，待原主账核验。","layer":"user","targetId":"user_auto_memory"}]}</hide>';
    },
  });
  assert.equal(candidateResult.promotedCount, 1, 'important-event candidates continue through the same reviewer');
  assert.equal(promptCalls, 2, 'one call per turn, not a second reviewer');
  // Forged source, wrong run, assistant assertions and zero-exit API failures
  // cannot activate an operational method.
  const method = { key: 'bot-capability-check', kind: 'method', scope: 'instance',
    content: '判断飞书权限前，核对当前 Bot 身份、接口错误和资源访问；入口失败后检查已授权的替代路径。',
    cues: ['飞书', '权限', 'feishu'], conditions: '本实例飞书操作报错时',
    exceptions: '应用 scope、用户 OAuth 和资源 ACL 分别核验；不扩大已有授权', tested: true,
    evidence: [{ seq: 2, quote: '"code":0' }] };
  result = await apply([method], sources('forged', '检查权限', '{"code":403}'));
  assert.equal(result.promotedCount, 0);
  const falseSuccess = { ...method, evidence: [{ seq: 2, quote: 'permission_violations' }] };
  result = await apply([falseSuccess], sources('real_missing', '检查权限', '{"code":99991672,"permission_violations":["scope"]}', 0));
  assert.equal(result.results[0].status, 'observed');
  for (const [key, output, exitCode] of [
    ['failed-process', '{"code":0}', 1],
    ['small-business-error', '{"code":1,"message":"failed"}', 0],
    ['late-business-failure', '{"code":0}' + 'x'.repeat(1800) + '{"code":403}', 0],
  ]) {
    const failed = await apply([{ ...method, key, evidence: [{ seq: 2,
      quote: key === 'small-business-error' ? '"code":1' : '"code":0' }] }], sources(key, '检查权限', output, exitCode));
    assert.equal(failed.results[0].status, 'observed', 'failed process or truncated late failure cannot be activated');
  }
  for (const [key, output] of [
    ['http-success', '{"statusCode":200,"data":"checked"}'],
    ['document-discusses-permissions', '{"code":0,"data":{"text":"本文讨论无权限的误判"}}'],
  ]) {
    const accepted = await apply([{ ...method, key, content: '读取成功响应时按返回结果确认当前操作。', cues: ['成功响应'],
      evidence: [{ seq: 2, quote: key === 'http-success' ? '"statusCode":200' : '"code":0' }] }], sources(key, '检查权限', output, 0));
    assert.equal(accepted.results[0].status, 'verified', 'successful envelope is not a permission failure because of HTTP 200 or document content');
  }
  assert.doesNotMatch(await context('飞书权限'), /bot-capability|判断飞书权限前/);
  let methodEntry = (await snapshot()).handbook.entries.find(e => e.key === method.key);
  result = await apply([{ ...method, expectedVersion: methodEntry.version }], sources('success', '检查权限', '{"code":0,"resource":"checked"}', 0));
  assert.equal(result.results[0].status, 'verified');
  assert.match(await context('飞书权限'), /资源 ACL 分别核验/);
  assert.doesNotMatch(await context('解释方案'), /判断飞书权限前/);
  methodEntry = (await snapshot()).handbook.entries.find(e => e.key === method.key);
  result = await apply([{ ...method, action: 'outcome', expectedVersion: methodEntry.version }], sources('outcome', '检查权限', '{"code":0}'));
  assert.equal(result.promotedCount, 0, 'not retrieved is not a method-use outcome');
  result = await apply([{ ...method, action: 'outcome', reason: '核对 Bot 后原接口成功', expectedVersion: methodEntry.version }],
    sources('outcome', '检查权限', '{"code":0}'), { delivered: [{ id: methodEntry.id, version: methodEntry.version }] });
  assert.equal(result.promotedCount, 1);
  assert.match((await snapshot()).handbook.entries.find(e => e.key === method.key).outcomes[0].reason, /原接口成功/);
  assert.equal((await snapshot()).handbook.entries.find(e => e.key === method.key).outcomes[0].memoryVersion, methodEntry.version);
  methodEntry = (await snapshot()).handbook.entries.find(e => e.key === method.key);
  result = await apply([{ ...method, key: 'project-build', scope: 'project', content: '只在项目 A 复用构建步骤。', cues: ['构建'] }], sources('project', 'build', '{"code":0}'), { project: 'project-a' });
  assert.equal(result.results[0].status, 'verified');
  assert.match(await context('构建', { project: 'project-a' }), /只在项目 A/);
  assert.doesNotMatch(await context('构建', { project: 'project-b' }), /只在项目 A/);
  // Explicit withdrawal tombstones the same semantic key, including a switch
  // from habit to preference, and leaves manual text and revision history intact.
  result = await apply([{ ...habit, kind: 'preference', action: 'withdraw', explicit: true, expectedVersion: entry.version,
    evidence: [{ seq: 1, quote: '撤销这个偏好' }], reason: '本人撤销' }], sources('withdraw', '撤销这个偏好'));
  assert.equal(result.results[0].status, 'withdrawn');
  entry = (await snapshot()).profile.entries[0];
  assert.equal(entry.history.at(-1).status, 'confirmed');
  result = await apply([{ ...habit, expectedVersion: entry.version }], sources('later', '用大白话解释'));
  assert.equal(result.promotedCount, 0);
  assert.match(await context(), /withdrawn.*大白话/);
  const manualWithdrawal = { key: 'name-address', kind: 'preference', action: 'withdraw', explicit: true,
    supersedesManual: '使用全名', content: '不再默认用全名称呼。',
    evidence: [{ seq: 1, quote: '撤销使用全名这个称呼偏好' }] };
  result = await apply([manualWithdrawal], sources('manual_withdraw', '撤销使用全名这个称呼偏好'));
  assert.equal(result.results[0].status, 'withdrawn');
  assert.match(await context(), /替代人工原文：使用全名/);
  assert.match((await snapshot()).profile.prefix, /人工维护的称呼偏好：使用全名/);
  const manualEntry = (await snapshot()).profile.entries.find(e => e.key === 'name-address');
  result = await apply([{ ...manualWithdrawal, key: 'fake-old-record', supersedesManual: '不存在的旧条目' }], sources('fake_manual', '撤销使用全名这个称呼偏好'));
  assert.equal(result.promotedCount, 0);
  result = await apply([{ ...manualWithdrawal, action: 'restore', expectedVersion: manualEntry.version,
    content: '按本人新要求恢复使用全名。', evidence: [{ seq: 1, quote: '恢复使用全名这个称呼偏好' }] }], sources('manual_restore', '恢复使用全名这个称呼偏好'));
  assert.equal(result.results[0].status, 'confirmed');
  assert.equal((await snapshot()).profile.entries.find(e => e.key === 'name-address').history.at(-1).status, 'withdrawn');
  result = await apply([{ ...method, action: 'counterexample', expectedVersion: methodEntry.version,
    evidence: [{ seq: 1, quote: '这个场景不适用' }] }], sources('counter', '这个场景不适用'));
  assert.equal(result.results[0].status, 'observed');
  assert.doesNotMatch(await context('飞书权限'), /判断飞书权限前/);
  result = await apply([{ ...method, action: 'revise', expectedVersion: 1 }], sources('stale', '检查权限', '{"code":0}'));
  assert.equal(result.promotedCount, 0);
  // Locks and malformed documents preserve the original rather than silently
  // losing an edit or recreating memory. Path symlinks cannot redirect writes.
  const before = await readFile(paths.profile, 'utf8');
  await mkdir(`${paths.profile}.learning-lock`);
  result = await apply([{ ...habit, key: 'another-habit' }], sources('locked', '用大白话解释'));
  assert.equal(result.promotedCount, 0);
  assert.equal(await readFile(paths.profile, 'utf8'), before);
  await rm(`${paths.profile}.learning-lock`, { recursive: true });
  await writeFile(paths.profile, 'do not erase\n<!-- remotelab-learning:start -->');
  result = await apply([{ ...habit, key: 'another-habit' }], sources('invalid', '用大白话解释'));
  assert.equal(result.promotedCount, 0);
  assert.match(await readFile(paths.profile, 'utf8'), /do not erase/);
  await rm(paths.profile);
  const outside = join(home, 'outside.md'); await writeFile(outside, 'CORE PRINCIPLES');
  await symlink(outside, paths.profile);
  result = await apply([{ ...habit, key: 'another-habit' }], sources('symlink', '用大白话解释'));
  assert.equal(result.promotedCount, 0);
  assert.equal(await readFile(outside, 'utf8'), 'CORE PRINCIPLES');
  await rm(paths.profile); await writeFile(paths.profile, before);
  await writeFile(policyPath, '{bad json');
  assert.match(await context('飞书权限'), /policy unavailable/);
  console.log('MEMORY_LEARNING_VERIFIED: ordinary habits, independent-session evidence, explicit preferences, short-turn review, Bot capability and real missing-permission boundary, versioned withdrawal/counterexamples, receipt-bound outcomes, scoped bounded retrieval, preserved manual text, lock and malformed/symlink protection; isolated fixtures only.');
} finally { await rm(home, { recursive: true, force: true }); }
