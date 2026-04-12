#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const previousHome = process.env.HOME;
const previousWritebackSetting = process.env.REMOTELAB_MEMORY_WRITEBACK;

const tempHome = await mkdtemp(join(tmpdir(), 'remotelab-memory-writeback-'));
process.env.HOME = tempHome;

const { maybeRunMemoryWriteback } = await import('../chat/session-memory-writeback.mjs');

let promptCalls = 0;
let lastPrompt = '';
const runPrompt = async (prompt) => {
  promptCalls += 1;
  lastPrompt = prompt;
  return `<hide>{"shouldWrite":true,"learnings":[{"category":"workflow","content":"User prefers compact audit summaries.","layer":"user"}]}</hide>`;
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

const auditLog = await readFile(
  join(tempHome, '.remotelab', 'memory', 'model-context', 'session-learnings', 'learnings.jsonl'),
  'utf8',
);
assert.match(auditLog, /User prefers compact audit summaries\./);

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
assert.equal(promptCalls, 3, 'explicit off should prevent the reviewer prompt from running');

if (previousWritebackSetting === undefined) delete process.env.REMOTELAB_MEMORY_WRITEBACK;
else process.env.REMOTELAB_MEMORY_WRITEBACK = previousWritebackSetting;
if (previousHome === undefined) delete process.env.HOME;
else process.env.HOME = previousHome;
await rm(tempHome, { recursive: true, force: true });

console.log('test-session-memory-writeback: ok');
