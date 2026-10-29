import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const home = await mkdtemp(join(tmpdir(), 'remotelab-rule-context-'));
setIsolatedTestHome(home);
const { projectRuleContext } = await import('../chat/rule-context.mjs');
const { renderModelContextSlots } = await import('../chat/model-context-slots.mjs');
const { recoverCodexRules } = await import('../chat/codex-rule-recovery.mjs');
const { CONFIG_DIR } = await import('../lib/config.mjs');
const rules = [
  { id: 'surface_messages', title: 'Display', content: 'DISPLAY_RULE', delivery: 'turn' },
  { id: 'inflight_trial', title: 'Personal tools', content: 'PERSONAL_TOOL_RULE', delivery: 'turn' },
  { id: 'inflight_trial_input', title: 'Input address', content: 'CURRENT_INPUT_ID', delivery: 'turn' },
  { id: 'strict_start_check', title: 'Personal', content: 'PERSON_A_STRICT', delivery: 'turn' },
  { id: 'project_memory', title: 'Current project background', content: 'PROJECT_BRIEF_V1', delivery: 'turn' },
  { id: 'turn_context', title: 'Current facts', content: 'NEW_FACT', delivery: 'turn' },
  { id: 'session_workboard_state', title: 'Task state', content: 'CURRENT_TASK', delivery: 'turn' },
];
const options = { enabled: true, recovery: 'codex-session-start', requestId: 'current', personId: 'a', identityId: 'identity-a',
  identity: { field: 'codexThreadId', id: 'thread' } };
const deps = { head: async () => 42,
  history: async () => [{ type: 'message', role: 'user', requestId: 'previous' }],
  request: async () => ({ runId: 'run', requestId: 'previous' }),
  run: async () => ({ id: 'run', sessionId: 'session', codexThreadId: 'thread' }),
  accepted: async () => ({ state: 'accepted' }), manifest: async () => ({}) };
const project = (slots = rules, opts = {}, overrides = {}) => projectRuleContext('session', slots,
  { ...options, ...opts }, { ...deps, ...overrides });
try {
  const first = await project();
  const skillSlot = { id: 'skill_extraction_trial', title: 'Skill pilot', content: 'PERSON_A_SKILL_POINTER', delivery: 'turn' };
  const withSkill = await project([...rules, skillSlot]);
  const skillSnapshot = JSON.parse(await readFile(withSkill.receipt.file, 'utf8'));
  assert.ok(skillSnapshot.rules.some(slot => slot.id === skillSlot.id));
  const removedSkill = await project(rules, {}, { manifest: async () => ({ ruleContextDelivery: withSkill.receipt }) });
  assert.ok(removedSkill.receipt.removedIds.includes(skillSlot.id), 'switching pilot off removes the previous active rule');
  assert.equal(first.receipt.mode, 'full');
  const snapshot = JSON.parse(await readFile(first.receipt.file, 'utf8'));
  assert.equal(snapshot.rules.length, 4);
  assert.doesNotMatch(JSON.stringify(snapshot), /NEW_FACT|CURRENT_TASK/);
  const acknowledged = { manifest: async () => ({ ruleContextDelivery: first.receipt }) };
  // Changing only the current input must not resend fixed review/knowledge or
  // routing rules. Plans and scope changes must still invalidate their slots.
  const { featureObservationPrompt } = await import('../chat/feature-observation.mjs');
  const { knowledgePilotPrompt } = await import('../chat/knowledge-pilot.mjs');
  const compactRules = [
    { id: 'delivery_self_review', content: featureObservationPrompt(null, null, true, { reviewVersion: 2 }) },
    { id: 'organization_knowledge', content: knowledgePilotPrompt({ personId: 'a' }) },
    { id: 'parallel_work', content: 'PLAN_A: requires human authorization' },
    { id: 'group_routing', content: 'ROUTING_DISABLED: keep the current work' },
  ];
  const addressed = requestId => [...compactRules, { id: 'current_input', content: JSON.stringify({ requestId }) }];
  const addressedFirst = await project(addressed('one'));
  const addressedAck = { manifest: async () => ({ ruleContextDelivery: addressedFirst.receipt }) };
  const addressedNext = await project(addressed('two'), {}, addressedAck);
  assert.equal(addressedNext.receipt.mode, 'reference');
  assert.match(renderModelContextSlots(addressedNext.slots), /"requestId":"two"/);
  assert.doesNotMatch(renderModelContextSlots(addressedNext.slots), /PLAN_A|ROUTING_DISABLED|feature-observation|knowledge search/);
  const changedPlan = await project(addressed('two').map(s => s.id === 'parallel_work' ? { ...s, content: 'PLAN_B' } : s), {}, addressedAck);
  assert.deepEqual(changedPlan.receipt.changedIds, ['parallel_work']);
  assert.equal((await project(addressed('two'), { personId: 'b' }, addressedAck)).receipt.mode, 'full');
  const next = await project(rules, {}, acknowledged);
  assert.equal(next.receipt.mode, 'reference');
  assert.doesNotMatch(renderModelContextSlots(next.slots), /DISPLAY_RULE|PERSON_A_STRICT|PERSONAL_TOOL_RULE|PROJECT_BRIEF_V1/);
  assert.match(renderModelContextSlots(next.slots), /NEW_FACT/);
  assert.match(renderModelContextSlots(next.slots), /CURRENT_INPUT_ID/);
  assert.match(renderModelContextSlots(next.slots), /CURRENT_TASK/);
  assert.match(renderModelContextSlots(next.slots), /after compaction/);
  assert.deepEqual(JSON.parse(await readFile(next.receipt.file, 'utf8')), snapshot, 'recovery reference contains complete immutable rules');
  for (const opts of [{ recovery: '' }, { identity: null }, { identity: { field: 'codexThreadId', id: 'new-thread' } },
    { personId: 'b' }, { identityId: 'new-id' }, { sourceContext: { connector: 'feishu', chatId: 'other' } }]) {
    assert.equal((await project(rules, opts, acknowledged)).receipt.mode, 'full');
  }
  for (const state of ['dispatching', 'rejected', 'uncertain']) {
    assert.equal((await project(rules, {}, { ...acknowledged, accepted: async () => ({ state }) })).receipt.mode, 'full');
  }
  const changed = await project(rules.filter(x => x.id !== 'strict_start_check'), {}, acknowledged);
  assert.equal(changed.receipt.mode, 'delta');
  assert.match(renderModelContextSlots(changed.slots), /no longer apply/);
  assert.doesNotMatch(renderModelContextSlots(changed.slots), /PERSON_A_STRICT/);
  const returned = await project(rules, {}, { manifest: async () => ({ ruleContextDelivery: changed.receipt }) });
  assert.equal(returned.receipt.mode, 'delta', 'A -> B -> A reloads the reintroduced rule');
  assert.deepEqual(returned.receipt.changedIds, ['strict_start_check']);
  assert.match(renderModelContextSlots(returned.slots), /PERSON_A_STRICT/);
  const revised = rules.map(x => x.id === 'surface_messages' ? { ...x, content: 'DISPLAY_V2' } : x);
  const updated = await project(revised, {}, acknowledged);
  assert.equal(updated.receipt.mode, 'delta');
  assert.deepEqual(updated.receipt.changedIds, ['surface_messages']);
  assert.match(renderModelContextSlots(updated.slots), /DISPLAY_V2/);
  assert.doesNotMatch(renderModelContextSlots(updated.slots), /PERSON_A_STRICT|PROJECT_BRIEF_V1/);
  // A changed project brief is delivered whole, with unrelated rules reused.
  const revisedProject = rules.map(x => x.id === 'project_memory' ? { ...x, content: 'PROJECT_BRIEF_V2_TAIL_CONSTRAINT' } : x);
  const updatedProject = await project(revisedProject, {}, acknowledged);
  assert.deepEqual(updatedProject.receipt.changedIds, ['project_memory']);
  assert.match(renderModelContextSlots(updatedProject.slots), /PROJECT_BRIEF_V2_TAIL_CONSTRAINT/);
  const removedProject = await project(rules.filter(x => x.id !== 'project_memory'), {}, acknowledged);
  assert.deepEqual(removedProject.receipt.removedIds, ['project_memory']);
  assert.match(renderModelContextSlots(removedProject.slots), /Removed slots no longer apply: project_memory/);
  // Compaction after a delta must restore the FULL current configuration,
  // including omitted unchanged rules and the latest complete project body.
  const transcript = join(home, 'delta-transcript.jsonl');
  await writeFile(transcript, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user',
    content: [{ type: 'input_text', text: renderModelContextSlots(updatedProject.slots) }] } }) + '\n');
  const recovered = await recoverCodexRules({ transcript_path: transcript }, 'session', CONFIG_DIR);
  assert.match(recovered, /DISPLAY_RULE/); assert.match(recovered, /PERSON_A_STRICT/);
  assert.match(recovered, /PROJECT_BRIEF_V2_TAIL_CONSTRAINT/); assert.doesNotMatch(recovered, /PROJECT_BRIEF_V1/);
  const directorySlot = { id: 'project_work_directory', title: 'Hidden project work directory', content: 'DIRECTORY_V1', delivery: 'turn' };
  const withDirectory = [...rules, directorySlot];
  const directoryFirst = await project(withDirectory);
  const directoryAck = { manifest: async () => ({ ruleContextDelivery: directoryFirst.receipt }) };
  assert.equal((await project(withDirectory, {}, directoryAck)).receipt.mode, 'reference');
  const directoryNext = await project([...rules, { ...directorySlot, content: 'DIRECTORY_V2_NEW_CHILD' }], {}, directoryAck);
  assert.deepEqual(directoryNext.receipt.changedIds, ['project_work_directory']);
  assert.doesNotMatch(renderModelContextSlots(directoryNext.slots), /PROJECT_BRIEF_V1/);
  assert.match(renderModelContextSlots(directoryNext.slots), /DIRECTORY_V2_NEW_CHILD/);
  await writeFile(transcript, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user',
    content: [{ type: 'input_text', text: renderModelContextSlots(directoryNext.slots) }] } }) + '\n');
  const directoryRecovered = await recoverCodexRules({ transcript_path: transcript }, 'session', CONFIG_DIR);
  assert.match(directoryRecovered, /DIRECTORY_V2_NEW_CHILD/); assert.match(directoryRecovered, /PROJECT_BRIEF_V1/);
  const directoryOff = await project(rules, {}, directoryAck);
  assert.deepEqual(directoryOff.receipt.removedIds, ['project_work_directory']);
  const learning = { id: 'personal_memory_learning', title: 'Personal memory learning', content: 'LEARNING_COMPACT', delivery: 'turn' };
  const learningFirst = await project([...rules, learning]);
  const learningAck = { manifest: async () => ({ ruleContextDelivery: learningFirst.receipt }) };
  assert.doesNotMatch(renderModelContextSlots((await project([...rules, learning], {}, learningAck)).slots), /LEARNING_COMPACT/);
  assert.match(renderModelContextSlots((await project([...rules, learning], { personId: 'b' }, learningAck)).slots), /LEARNING_COMPACT/);
  const paused = await project([...rules, { ...learning, content: 'LEARNING_PAUSED' }], {}, learningAck);
  assert.deepEqual(paused.receipt.changedIds, ['personal_memory_learning']);
  assert.match(renderModelContextSlots(paused.slots), /LEARNING_PAUSED/);
  assert.deepEqual((await project(rules, {}, learningAck)).receipt.removedIds, ['personal_memory_learning']);
  await writeFile(transcript, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user',
    content: [{ type: 'input_text', text: renderModelContextSlots(paused.slots) }] } }) + '\n');
  assert.match(await recoverCodexRules({ transcript_path: transcript }, 'session', CONFIG_DIR), /LEARNING_PAUSED/);
  const legacy = { ...first.receipt }; delete legacy.scopeHash; delete legacy.slotHashes;
  assert.equal((await project(rules, {}, { manifest: async () => ({ ruleContextDelivery: legacy }) })).receipt.mode, 'full');
  const supplement = { request: async () => ({ requestId: 'previous', nativeDispatchRunId: 'run',
    nativeReceipt: { accepted: true }, nativeRuleContextDelivery: first.receipt }) };
  assert.equal((await project(rules, {}, supplement)).receipt.mode, 'reference');
  const question = { requestId: 'answer', nativeDispatchRunId: 'run', options: { nativeQuestionId: 'question' },
    nativeReceipt: { accepted: true, mode: 'question_answer', questionId: 'question' }, nativeContext: '' };
  const afterQuestion = { ...acknowledged,
    history: async () => ['previous', 'answer'].map(requestId => ({ type: 'message', role: 'user', requestId })),
    request: async (_session, id) => id === 'answer' ? question : { runId: 'run', requestId: 'previous' } };
  assert.equal((await project(rules, {}, afterQuestion)).receipt.mode, 'reference', 'a native clarification answer does not erase delivered rules');
  assert.deepEqual((await project(revised, {}, afterQuestion)).receipt.changedIds, ['surface_messages']);
  assert.equal((await project(rules, { personId: 'b' }, afterQuestion)).receipt.mode, 'full');
  const diskAnswer = { ...question }; delete diskAnswer.nativeReceipt;
  assert.equal((await project(rules, {}, { ...afterQuestion,
    request: async (_session, id) => id === 'answer' ? diskAnswer : { runId: 'run', requestId: 'previous' },
    accepted: async (_run, id) => id === 'answer' ? { state: 'accepted', result: question.nativeReceipt } : { state: 'accepted' },
  })).receipt.mode, 'reference', 'durable question receipts survive controller restart');
  for (const q of [{ ...question, nativeReceipt: { accepted: true, mode: 'steer' } },
    { ...question, nativeReceipt: null }, { ...question, nativeContext: 'substantive context' }]) {
    assert.equal((await project(rules, {}, { ...afterQuestion,
      request: async (_session, id) => id === 'answer' ? q : { runId: 'run', requestId: 'previous' },
      accepted: async () => null,
    })).receipt.mode, 'full', 'only a proven context-free question answer may be skipped');
  }
  const starting = { identity: null, initialDelivery: { runId: 'run', receipt: first.receipt } };
  const unacknowledged = { accepted: async () => null };
  assert.equal((await project(rules, starting, unacknowledged)).receipt.mode, 'reference', 'Codex supplements follow the immutable root prompt during startup');
  assert.equal((await project(rules, { ...starting, personId: 'b' }, unacknowledged)).receipt.mode, 'full');
  assert.equal((await project(rules, { ...starting, recovery: '' }, unacknowledged)).receipt.mode, 'full');
  assert.equal((await project(rules, starting, { ...unacknowledged,
    request: async () => ({ requestId: 'previous', nativeDispatchRunId: 'run' }),
  })).receipt.mode, 'full', 'an intervening unacknowledged supplement cannot fall back to root rules');
  assert.deepEqual((await project(rules, starting, { request: async () => ({ requestId: 'previous', nativeDispatchRunId: 'run',
    nativeReceipt: { accepted: true }, nativeRuleContextDelivery: changed.receipt }) })).receipt.changedIds, ['strict_start_check'], 'accepted A-B-A updates take precedence over the initial baseline');
  assert.equal((await project(rules, {}, { ...acknowledged, run: async () => ({ id: 'run', sessionId: 'other', codexThreadId: 'thread' }) })).receipt.mode, 'full');
  assert.equal((await project(rules, { enabled: false })).receipt, null);
  const broken = await project(rules, {}, { snapshot: async () => { throw new Error('fixture disk unavailable'); } });
  assert.equal(broken.receipt, null); assert.deepEqual(broken.slots, rules);
  const missing = await project(rules, {}, { history: async () => { throw new Error('fixture history unavailable'); } });
  assert.equal(missing.receipt, null); assert.deepEqual(missing.slots, rules);
  // A missing recovery file must be repaired even when the context was accepted.
  await rm(first.receipt.file);
  await project(rules, {}, acknowledged);
  assert.deepEqual(JSON.parse(await readFile(first.receipt.file, 'utf8')), snapshot);
  console.log('rule context: accepted-only reuse, fresh/scope/version changes, removed rules, A-B-A, supplementary inputs, immutable recovery and failure fallback passed');
} finally { await rm(home, { recursive: true, force: true }); }
