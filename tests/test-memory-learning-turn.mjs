import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'learning-turn-'));
setIsolatedTestHome(home);
process.env.REMOTELAB_MEMORY_DIR = join(home, 'memory');
process.env.REMOTELAB_CONFIG_DIR = join(home, 'config');
try {
  await mkdir(process.env.REMOTELAB_CONFIG_DIR, { recursive: true });
  await mkdir(process.env.REMOTELAB_MEMORY_DIR, { recursive: true });
  const { AUTH_FILE } = await import('../lib/config.mjs');
  await writeFile(AUTH_FILE, JSON.stringify({ version: 2, serviceToken: 'test-only', people: [
    { id: 'person_alpha', identities: [{ id: 'identity_alpha', kind: 'web', subjectId: 'alpha' }] },
    { id: 'person_beta', identities: [{ id: 'identity_beta', kind: 'web', subjectId: 'beta' }] },
  ] }));
  const { loadAuthDocument } = await import('../lib/auth-config.mjs');
  const authDocument = await loadAuthDocument();
  const m = await import('../chat/memory-learning.mjs');
  await writeFile(join(process.env.REMOTELAB_MEMORY_DIR, 'learning-policy.json'), JSON.stringify({
    version: 1, enabled: true, profiles: true, handbook: true, context: true, personIds: ['person_alpha'],
  }));
  const actor = { personId: 'person_alpha', identityId: 'identity_alpha', authDocument };
  const sources = m.learningTurnEvidence({ sessionId: 'source', runId: 'run_source',
    userMessage: '以后方案都请用具体例子解释', sourceEventSeq: 1 });
  const update = { kind: 'preference', key: 'concrete-examples', content: '讲方案时使用具体例子。',
    cues: ['方案'], explicit: true, evidence: [{ seq: 1, quote: '以后方案都请用具体例子解释' }] };
  const result = await m.applyLearningUpdates({ ...actor, sources, updates: [update] });
  assert.equal(result.promotedCount, 1);
  const { buildPrompt } = await import('../chat/session-manager.mjs');
  const session = { id: 'learning_turn', name: 'learning', tool: 'codex', cwd: home, activeAgreements: [], workboardPilot: false };
  const options = { skipSessionContinuation: true, workboardEnabled: false,
    viewPersonId: actor.personId, initiatedByIdentityId: actor.identityId, memoryQuery: '解释方案' };
  const fresh = await buildPrompt(session.id, session, '解释方案', '', 'codex', { userMessageCount: 0 }, options);
  assert.match(fresh, /Person memory pointer/);
  assert.doesNotMatch(fresh, /讲方案时使用具体例子|Scoped collaboration memory|mem_[a-f0-9]{16} v1/);
  const retrieved = await m.buildLearningContext({ ...actor, query: '解释方案' });
  assert.match(retrieved, /confirmed.*具体例子/);
  assert.match(retrieved, new RegExp(`${result.results[0].id} v1`));
  const resumed = await buildPrompt(session.id, { ...session, resumeSessionId: 'native-thread' },
    '解释方案', 'codex', 'codex', { userMessageCount: 2 }, options);
  assert.match(resumed, /Person memory pointer/);
  assert.doesNotMatch(resumed, /讲方案时使用具体例子/);
  const wrongActor = await buildPrompt(session.id, session, '解释方案', '', 'codex', { userMessageCount: 0 },
    { ...options, initiatedByIdentityId: 'identity_beta' });
  assert.doesNotMatch(wrongActor, /讲方案时使用具体例子/);
  await m.applyLearningUpdates({ ...actor, sources: m.learningTurnEvidence({ sessionId: 'withdraw', runId: 'run_withdraw',
    userMessage: '撤销具体例子这个默认要求', sourceEventSeq: 1 }), updates: [{ ...update, action: 'withdraw',
    expectedVersion: 1, evidence: [{ seq: 1, quote: '撤销具体例子这个默认要求' }] }] });
  const after = await buildPrompt(session.id, session, '解释方案', 'codex', 'codex', { userMessageCount: 3 }, options);
  assert.doesNotMatch(after, /讲方案时使用具体例子/);
  const afterRetrieval = await m.buildLearningContext({ ...actor, query: '解释方案' });
  assert.match(afterRetrieval, /withdrawn.*具体例子/);
  assert.doesNotMatch(afterRetrieval, /confirmed.*具体例子/);
  assert.match(afterRetrieval, /must no longer guide work/);
  // The reviewer sees actual turn delivery IDs, not a claim that retrieval
  // means the assistant followed them. No model is launched by this fixture.
  let calls = 0;
  await m.reviewMemoryLearning({ ...actor, sessionId: session.id, session, run: { id: 'run_review' },
    userMessage: '解释方案', sourceEventSeq: 1, assistantTurnText: '回答',
    turnEvents: [{ type: 'manager_context', runId: 'run_review', content: fresh, seq: 2 }],
    runPrompt: async prompt => { calls += 1; assert.match(prompt, new RegExp(`Actually delivered entry versions: \\[\\]`)); return '<hide>{"updates":[]}</hide>'; },
  });
  assert.equal(calls, 1);
  // CLI binds on-demand retrieval and edits to the accepted Request actor.
  const { requests } = await import('../chat/requests.mjs');
  const { appendEvent, loadHistory } = await import('../chat/history.mjs');
  const { runMemoryLearningCommand } = await import('../lib/memory-learning-command.mjs');
  const cliSession = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', cliRun = 'run_cli_fixture';
  await requests.accept({ sessionId: cliSession, requestId: 'cli_request', runId: cliRun,
    text: '撤销这个权限检查方法', options: { viewPersonId: actor.personId, initiatedByIdentityId: actor.identityId } });
  const original = await appendEvent(cliSession, { type: 'message', role: 'user', content: '撤销这个权限检查方法', runId: cliRun, requestId: 'cli_request' });
  const method = { kind: 'method', key: 'permission-check', content: '查询当前身份和目标资源权限。',
    cues: ['权限'], conditions: '资源操作报错时', exceptions: '不同身份和资源权限分别检查，不扩大授权',
    scope: 'instance', tested: true, evidence: [{ seq: 2, quote: '"code":0' }] };
  await m.applyLearningUpdates({ ...actor, sources: m.learningTurnEvidence({ sessionId: 'method_source', runId: 'run_method_source',
    userMessage: '检查权限', sourceEventSeq: 1, turnEvents: [{ type: 'tool_result', seq: 2, runId: 'run_method_source', exitCode: 0, output: '{"code":0}' }] }), updates: [method] });
  let printed = '';
  const io = { stdout: { write(value) { printed += value; } } };
  await runMemoryLearningCommand(['context', '--query', '权限', '--run-id', cliRun, '--json'], io);
  assert.match(JSON.parse(printed).context, /verified.*查询当前身份/);
  const receipts = m.learningDeliveryReceipts(await loadHistory(cliSession), cliRun);
  assert.ok(receipts.some(r => r.status === 'verified' && r.version === 1));
  const payload = join(home, 'update.json');
  await writeFile(payload, JSON.stringify({ updates: [{ ...method, action: 'withdraw', expectedVersion: 1,
    evidence: [{ seq: original.seq, quote: '撤销这个权限检查方法' }] }] }));
  printed = '';
  assert.equal(await runMemoryLearningCommand(['apply', '--file', payload, '--run-id', cliRun, '--json'], io), 0);
  assert.equal(JSON.parse(printed).results[0].status, 'withdrawn');
  assert.ok((await loadHistory(cliSession)).some(e => e.operation === 'write_memory' && e.phase === 'applied'));
  assert.match(await m.buildLearningContext({ ...actor, query: '一个新任务' }), /withdrawn.*查询当前身份/);
  // A later authenticated Person can steer the same physical Run. Their
  // message must not inherit the original requester's personal identity.
  await requests.accept({ sessionId: cliSession, requestId: 'beta_input', runId: 'run_beta_input',
    text: '我来继续这个方案', options: { viewPersonId: 'person_beta', initiatedByIdentityId: 'identity_beta' } });
  await appendEvent(cliSession, { type: 'message', role: 'user', content: '我来继续这个方案', requestId: 'beta_input', runId: cliRun });
  printed = '';
  await runMemoryLearningCommand(['inspect', '--run-id', cliRun, '--json'], io);
  assert.equal(JSON.parse(printed).personId, 'person_beta');
  assert.doesNotMatch(JSON.stringify(JSON.parse(printed).profile), /具体例子/);
  // A source association, not a cwd/title, defines the project scope.
  const config = { schemaVersion: 1, enabled: true, contextEnabled: true, reviewEnabled: true, releaseId: 'fixture',
    indexPath: join(home, 'index.md'), ledgerPath: join(home, 'ledger.md'), workflowPath: join(home, 'workflow.md'),
    projects: [{ id: 'alpha' }, { id: 'beta' }], sessionBindings: [], groups: [
      { sourceRouteId: 'bot-a', chatId: 'alpha-chat', projectIds: ['alpha'] },
      { sourceRouteId: 'bot-a', chatId: 'mixed-chat', projectIds: ['alpha', 'beta'] },
    ] };
  await writeFile(join(process.env.REMOTELAB_MEMORY_DIR, 'project-runtime.json'), JSON.stringify(config));
  const { resolveLearningProject } = await import('../chat/project-memory-runtime.mjs');
  const oldSession = { ...session, conversation: { sourceRouteId: 'bot-a', target: { chatId: 'alpha-chat' } } };
  assert.equal(await resolveLearningProject(oldSession, { sourceRouteId: 'bot-a', chatId: 'alpha-chat' }), 'alpha');
  assert.equal(await resolveLearningProject(oldSession, { sourceRouteId: 'bot-a', chatId: 'mixed-chat' }), '');
  assert.equal(await resolveLearningProject(oldSession, { sourceRouteId: 'bot-a', chatId: 'unassigned' }), '');
  console.log('MEMORY_LEARNING_TURN_VERIFIED: fresh/resumed buildPrompt keeps identity pointers; scoped bodies and withdrawals require explicit retrieval; mismatched current identity excluded; withdrawal replaces active default; post-turn review receives delivery IDs; no live preference writes or model launch.');
} finally { await rm(home, { recursive: true, force: true }); }
