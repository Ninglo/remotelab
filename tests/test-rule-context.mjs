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
  assert.equal(first.receipt.mode, 'full');
  const snapshot = JSON.parse(await readFile(first.receipt.file, 'utf8'));
  assert.equal(snapshot.rules.length, 4);
  assert.doesNotMatch(JSON.stringify(snapshot), /NEW_FACT|CURRENT_TASK/);
  const acknowledged = { manifest: async () => ({ ruleContextDelivery: first.receipt }) };
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
  const legacy = { ...first.receipt }; delete legacy.scopeHash; delete legacy.slotHashes;
  assert.equal((await project(rules, {}, { manifest: async () => ({ ruleContextDelivery: legacy }) })).receipt.mode, 'full');
  const supplement = { request: async () => ({ requestId: 'previous', nativeDispatchRunId: 'run',
    nativeReceipt: { accepted: true }, nativeRuleContextDelivery: first.receipt }) };
  assert.equal((await project(rules, {}, supplement)).receipt.mode, 'reference');
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
