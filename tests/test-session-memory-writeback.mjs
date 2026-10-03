#!/usr/bin/env node
import assert from 'assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const previousHome = process.env.HOME;
const previousWritebackSetting = process.env.REMOTELAB_MEMORY_WRITEBACK;
const previousInstanceRoot = process.env.REMOTELAB_INSTANCE_ROOT;
const previousConfigDir = process.env.REMOTELAB_CONFIG_DIR;
const previousMemoryDir = process.env.REMOTELAB_MEMORY_DIR;
const previousWorkRoot = process.env.REMOTELAB_WORK_ROOT_DIR;

const tempHome = await mkdtemp(join(tmpdir(), 'remotelab-memory-writeback-'));
process.env.HOME = tempHome;
delete process.env.REMOTELAB_INSTANCE_ROOT;
process.env.REMOTELAB_CONFIG_DIR = join(tempHome, '.config', 'remotelab');
process.env.REMOTELAB_MEMORY_DIR = join(tempHome, '.remotelab', 'memory');
process.env.REMOTELAB_WORK_ROOT_DIR = join(tempHome, '.remotelab', 'workspace');

const { maybeRunMemoryWriteback } = await import('../chat/session-memory-writeback.mjs');

let promptCalls = 0;
let lastPrompt = '';
const runPrompt = async (prompt) => {
  promptCalls += 1;
  lastPrompt = prompt;
  return `<hide>{"shouldWrite":true,"learnings":[{"category":"workflow","content":"User prefers compact audit summaries.","layer":"user","targetId":"user_auto_memory"}]}</hide>`;
};

delete process.env.REMOTELAB_MEMORY_WRITEBACK;
const defaultResult = await maybeRunMemoryWriteback({
  sessionId: 'sess_memory_default',
  session: { name: 'Memory audit', group: 'Testing' },
  run: { id: 'run_default' },
  userMessage: 'Remember that I prefer short summaries for this kind of audit.',
  assistantTurnText: 'This is a sufficiently long assistant message intended to exercise the memory writeback path and confirm that the unset environment variable still allows the reviewer flow to run by default.',
  runPrompt,
});
assert.equal(defaultResult.attempted, true, 'memory writeback should attempt review when the env var is unset');
assert.equal(defaultResult.written, true, 'memory writeback should persist learnings by default when the reviewer approves them');
assert.equal(defaultResult.promotedCount, 1, 'memory writeback should promote new learnings into a durable memory file');
assert.deepEqual(
  defaultResult.promotedFiles,
  [join(tempHome, '.remotelab', 'memory', 'model-context', 'auto-user-memory.md')],
  'memory writeback should report the durable file it updated',
);
assert.equal(promptCalls, 1, 'memory writeback should invoke the reviewer prompt when enabled by default');
assert.match(lastPrompt, /Available memory targets:/, 'writeback prompt should now expose candidate memory targets');
assert.match(lastPrompt, /user_preferences \| user \| ~\/\.remotelab\/memory\/model-context\/preferences\.md/, 'prompt should expose specific user memory targets');
assert.match(lastPrompt, /user_auto_memory \| user \| ~\/\.remotelab\/memory\/model-context\/auto-user-memory\.md/, 'prompt should keep the auto fallback target');
assert.match(lastPrompt, /Choose the smallest correct layer by impact radius/, 'prompt should require impact-radius routing');
assert.match(lastPrompt, /Use user_preferences only for stable cross-session preferences/, 'prompt should protect global preferences from project detail');
assert.match(lastPrompt, /Dated one-off release records/, 'prompt should reject one-off operational residue');
assert.match(lastPrompt, /Every learning must include a listed targetId/, 'prompt should require explicit routing');

await assert.rejects(
  access(
    join(tempHome, '.remotelab', 'memory', 'model-context', 'session-learnings', 'learnings.jsonl'),
  ),
  { code: 'ENOENT' },
  'memory writeback should not create a raw session-learnings audit log',
);

const userAutoMemory = await readFile(
  join(tempHome, '.remotelab', 'memory', 'model-context', 'auto-user-memory.md'),
  'utf8',
);
assert.match(userAutoMemory, /# Auto-Promoted User Memory/);
assert.match(userAutoMemory, /- User prefers compact audit summaries\./);

const duplicateResult = await maybeRunMemoryWriteback({
  sessionId: 'sess_memory_duplicate',
  session: { name: 'Memory audit', group: 'Testing' },
  run: { id: 'run_duplicate' },
  userMessage: 'Repeat the same durable preference.',
  assistantTurnText: 'This is another long assistant message to exercise the same memory writeback path with a duplicate learning payload.',
  runPrompt,
});
assert.equal(duplicateResult.promotedCount, 0, 'duplicate learnings should not be re-appended to the durable memory file');

const userAutoMemoryBeforeInvalidRoute = await readFile(
  join(tempHome, '.remotelab', 'memory', 'model-context', 'auto-user-memory.md'),
  'utf8',
);
const invalidRouteResult = await maybeRunMemoryWriteback({
  sessionId: 'sess_memory_invalid_route',
  session: { name: 'Memory audit', group: 'Testing' },
  run: { id: 'run_invalid_route' },
  userMessage: 'This learning should not fall back if the reviewer invents a target.',
  assistantTurnText: 'This is a sufficiently long assistant message to exercise invalid target handling and confirm that an invented target id is not silently routed into fallback memory.',
  runPrompt: async (prompt) => {
    promptCalls += 1;
    lastPrompt = prompt;
    return `<hide>{"shouldWrite":true,"learnings":[{"category":"workflow","content":"Invented targets must not pollute fallback memory.","layer":"user","targetId":"invented_target"}]}</hide>`;
  },
});
assert.equal(invalidRouteResult.promotedCount, 0, 'invalid target ids should not be silently promoted into fallback memory');
assert.deepEqual(invalidRouteResult.promotedFiles, [], 'invalid target ids should not report promoted files');
assert.equal(
  await readFile(join(tempHome, '.remotelab', 'memory', 'model-context', 'auto-user-memory.md'), 'utf8'),
  userAutoMemoryBeforeInvalidRoute,
  'invalid target ids should leave fallback memory unchanged',
);

await mkdir(join(tempHome, '.remotelab', 'memory'), { recursive: true });
await writeFile(
  join(tempHome, '.remotelab', 'memory', 'writeback-targets.json'),
  `${JSON.stringify({
    extraTargets: [
      {
        id: 'custom_identity',
        path: '~/.remotelab/memory/reference/personal/identity.md',
        layer: 'user',
        description: 'Stable identity and personal background facts.',
        categories: ['environment', 'decision'],
      },
    ],
  }, null, 2)}\n`,
  'utf8',
);

const routedResult = await maybeRunMemoryWriteback({
  sessionId: 'sess_memory_routed',
  session: { name: 'Identity memory', group: 'Testing' },
  run: { id: 'run_routed' },
  userMessage: 'Remember that I am building a stable personal profile for repeated self-introductions.',
  assistantTurnText: 'This is a sufficiently long assistant message that should still qualify for memory writeback while explicitly routing the extracted learning into a configured custom memory target.',
  runPrompt: async (prompt) => {
    promptCalls += 1;
    lastPrompt = prompt;
    return `<hide>{"shouldWrite":true,"learnings":[{"category":"environment","content":"The user maintains a stable personal profile for repeated self-introductions.","layer":"user","targetId":"custom_identity"}]}</hide>`;
  },
});
assert.equal(routedResult.promotedCount, 1, 'configured targets should allow routing a learning into a specific user memory file');
assert.deepEqual(
  routedResult.promotedFiles,
  [join(tempHome, '.remotelab', 'memory', 'reference', 'personal', 'identity.md')],
  'configured routing should promote learnings into the requested custom target file',
);
assert.match(lastPrompt, /custom_identity \| user \| ~\/\.remotelab\/memory\/reference\/personal\/identity\.md/, 'prompt should expose custom configured memory targets');

const routedMemory = await readFile(
  join(tempHome, '.remotelab', 'memory', 'reference', 'personal', 'identity.md'),
  'utf8',
);
assert.match(routedMemory, /## Auto-Promoted Learnings/, 'custom targets should receive a dedicated auto-promoted learnings section');
assert.match(routedMemory, /The user maintains a stable personal profile for repeated self-introductions\./);

// Regression: blacklisting old task IDs allowed later task files to become
// automatic write targets. An allowlist must apply to discovered and extra
// targets, both fallbacks, and fail closed for an empty/malformed list.
const { loadMemoryWritebackTargets, resolveMemoryWritebackTarget } = await import('../chat/memory-writeback-targets.mjs');
const memoryRoot = join(tempHome, '.remotelab', 'memory');
const targetsFile = join(memoryRoot, 'writeback-targets.json');
await mkdir(join(memoryRoot, 'tasks'), { recursive: true });
await writeFile(join(memoryRoot, 'tasks', 'new-task.md'), '# New task\nUntouched original.\n');
const strictConfig = { allowedTargetIds: ['user_auto_memory', 'system_auto_memory'],
  extraTargets: [{ id: 'custom_task', path: join(memoryRoot, 'tasks', 'new-task.md'), layer: 'user', description: 'Extra task target', categories: ['workflow'] }] };
await writeFile(targetsFile, JSON.stringify(strictConfig));
let targets = await loadMemoryWritebackTargets();
assert.deepEqual(targets.map(target => target.id).sort(), ['system_auto_memory', 'user_auto_memory']);
assert.equal(resolveMemoryWritebackTarget(targets, {targetId:'system_auto_memory', layer:'system', category:'preference'}), null);
assert.equal(resolveMemoryWritebackTarget(targets, {targetId:'user_auto_memory', layer:'system', category:'workflow'}), null);
const newTaskBefore = await readFile(join(memoryRoot,'tasks','new-task.md'), 'utf8');
const strictResult = await maybeRunMemoryWriteback({sessionId:'sess_strict', run:{id:'run_strict'}, userMessage:'Remember this', sourceEventSeq:42,
  assistantTurnText:'A substantive completed response that exceeds the memory review minimum length and exercises several refused and allowed target choices.',
  runPrompt: async()=>'<hide>{"shouldWrite":true,"learnings":[{"targetId":"task_tasks_new-task_md","layer":"user","category":"workflow","content":"Must not alter task"},{"targetId":"custom_task","layer":"user","category":"workflow","content":"Must not alter extra target"},{"targetId":"system_auto_memory","layer":"system","category":"preference","content":"Must not become system preference"},{"targetId":"user_auto_memory","layer":"user","category":"preference","content":"A candidate with an attributed source to verify"}]}</hide>'});
assert.equal(strictResult.promotedCount,1);
assert.equal(await readFile(join(memoryRoot,'tasks','new-task.md'),'utf8'),newTaskBefore);
const sourced = await readFile(join(memoryRoot,'model-context','auto-user-memory.md'),'utf8');
assert.match(sourced, /"sessionId":"sess_strict"/); assert.match(sourced, /"runId":"run_strict"/);
assert.match(sourced, /"eventSeq":42/); assert.match(sourced, /"recordedAt":/);
assert.match(sourced, /"personAttribution":"verify-source-message"/);
await writeFile(targetsFile,JSON.stringify({...strictConfig,allowedTargetIds:[]}));
assert.deepEqual(await loadMemoryWritebackTargets(),[]);
await writeFile(targetsFile,JSON.stringify({...strictConfig,allowedTargetIds:'invalid'}));
assert.deepEqual(await loadMemoryWritebackTargets(),[]);
await writeFile(targetsFile,'{broken json');
assert.deepEqual(await loadMemoryWritebackTargets(),[], 'broken existing config must not restore default writers');
await writeFile(targetsFile,JSON.stringify({...strictConfig,allowedTargetIds:['system_auto_memory']}));
const rejectedCategory = await maybeRunMemoryWriteback({ sessionId:'sess_bad_category', run:{id:'run_bad_category'}, userMessage:'Remember this',
  assistantTurnText:'A substantive response that exceeds the minimum length and confirms rejected preferences do not count as a successful memory write.',
  runPrompt:async()=>'<hide>{"shouldWrite":true,"learnings":[{"targetId":"system_auto_memory","layer":"system","category":"preference","content":"Refused preference"}]}</hide>' });
assert.equal(rejectedCategory.written,false); assert.equal(rejectedCategory.promotedCount,0);
console.log('WRITEBACK_ALLOWLIST_VERIFIED: new tasks and configured extras refused; system preferences refused; empty/malformed allowlists fail closed; source recorded without guessed Person; no-write result remains false.');

process.env.REMOTELAB_MEMORY_WRITEBACK = 'off';
const explicitOffResult = await maybeRunMemoryWriteback({
  sessionId: 'sess_memory_disabled',
  session: { name: 'Memory audit', group: 'Testing' },
  run: { id: 'run_disabled' },
  userMessage: 'This should not run the reviewer.',
  assistantTurnText: 'This message is also long enough to qualify, but the feature should stay disabled because the env var explicitly turned it off.',
  runPrompt,
});
assert.deepEqual(explicitOffResult, { attempted: false, written: false }, 'memory writeback should still respect an explicit off setting');
assert.equal(promptCalls, 4, 'explicit off should prevent the reviewer prompt from running');

if (previousWritebackSetting === undefined) delete process.env.REMOTELAB_MEMORY_WRITEBACK;
else process.env.REMOTELAB_MEMORY_WRITEBACK = previousWritebackSetting;
if (previousInstanceRoot === undefined) delete process.env.REMOTELAB_INSTANCE_ROOT;
else process.env.REMOTELAB_INSTANCE_ROOT = previousInstanceRoot;
if (previousConfigDir === undefined) delete process.env.REMOTELAB_CONFIG_DIR;
else process.env.REMOTELAB_CONFIG_DIR = previousConfigDir;
if (previousMemoryDir === undefined) delete process.env.REMOTELAB_MEMORY_DIR;
else process.env.REMOTELAB_MEMORY_DIR = previousMemoryDir;
if (previousWorkRoot === undefined) delete process.env.REMOTELAB_WORK_ROOT_DIR;
else process.env.REMOTELAB_WORK_ROOT_DIR = previousWorkRoot;
if (previousHome === undefined) delete process.env.HOME;
else process.env.HOME = previousHome;
await rm(tempHome, { recursive: true, force: true });

console.log('test-session-memory-writeback: ok');
