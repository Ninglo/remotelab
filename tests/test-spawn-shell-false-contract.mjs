#!/usr/bin/env node
// Regression guard: spawn() calls must never be invoked with shell:true.
// Node's spawn() already defaults to shell:false, so this test documents the
// contract rather than blocking an active vulnerability. It would fail if
// shell:true were ever introduced, because the shell metacharacters in the
// prompt would be expanded instead of passed as a literal argument.
import assert from 'assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-shell-false-'));
const tempBin = join(tempHome, 'bin');
const tempConfig = join(tempHome, 'config');
const tempMemory = join(tempHome, 'memory');
const argvCapturePath = join(tempHome, 'captured-argv.json');
const shellProofPath = '/tmp/remotelab-shell-injection-test';
const fakeToolId = 'fake-shell-false-tool';

mkdirSync(tempBin, { recursive: true });
mkdirSync(tempConfig, { recursive: true });
mkdirSync(tempMemory, { recursive: true });

// Remove any leftover proof file from a previous failed run.
if (existsSync(shellProofPath)) rmSync(shellProofPath);

const fakeBinPath = join(tempBin, 'fake-shell-false-tool');
writeFileSync(
  fakeBinPath,
  `#!/usr/bin/env node
const fs = require('fs');
// If shell:true were used, the shell would have expanded $(touch ...) before
// invoking this binary; we capture argv to verify it arrived literally.
const capturePath = process.env.REMOTELAB_TEST_ARGV_CAPTURE;
if (capturePath) {
  fs.writeFileSync(capturePath, JSON.stringify(process.argv.slice(2)), 'utf8');
}
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fake-thread' }));
console.log(JSON.stringify({ type: 'turn.started' }));
console.log(JSON.stringify({
  type: 'item.completed',
  item: { type: 'agent_message', text: 'shell-false-ok' },
}));
console.log(JSON.stringify({
  type: 'turn.completed',
  usage: { input_tokens: 1, output_tokens: 1 },
}));
`,
  'utf8',
);
chmodSync(fakeBinPath, 0o755);

writeFileSync(
  join(tempConfig, 'tools.json'),
  JSON.stringify(
    [
      {
        id: fakeToolId,
        name: 'Fake Shell False Tool',
        command: fakeBinPath,
        runtimeFamily: 'codex-json',
        models: [{ id: 'fake-model', label: 'Fake model' }],
        reasoning: { kind: 'enum', label: 'Reasoning', levels: ['low'], default: 'low' },
      },
    ],
    null,
    2,
  ),
  'utf8',
);

process.env.HOME = tempHome;
process.env.PATH = `${tempBin}:${process.env.PATH}`;
process.env.REMOTELAB_CONFIG_DIR = tempConfig;
process.env.REMOTELAB_MEMORY_DIR = tempMemory;
process.env.REMOTELAB_TEST_ARGV_CAPTURE = argvCapturePath;
delete process.env.REMOTELAB_INSTANCE_ROOT;
delete process.env.CODEX_HOME;

// Payload containing shell metacharacters. If shell:true were used, the
// $(touch ...) subshell would create shellProofPath.
const shellMetaPrompt = `$(touch ${shellProofPath}) hello world`;

// --- Test 1: session-detached-assistant.mjs ---
const { runDetachedAssistantPrompt } = await import(
  pathToFileURL(join(repoRoot, 'chat', 'session-detached-assistant.mjs')).href
);

await runDetachedAssistantPrompt(
  { id: 'session_shell_test', folder: tempHome, tool: fakeToolId },
  shellMetaPrompt,
);

assert.ok(!existsSync(shellProofPath), 'shell:true would have created shellProofPath via $() expansion');
const detachedArgv = JSON.parse(readFileSync(argvCapturePath, 'utf8'));
assert.ok(
  detachedArgv.some((a) => a.includes('$(touch')),
  'metacharacter prompt should arrive as a literal argument, not be expanded',
);

// --- Test 2: summarizer.mjs via triggerSessionLabelSuggestion ---
const sessionManager = await import(pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href);
const history = await import(pathToFileURL(join(repoRoot, 'chat', 'history.mjs')).href);
const normalizer = await import(pathToFileURL(join(repoRoot, 'chat', 'normalizer.mjs')).href);
const summarizer = await import(pathToFileURL(join(repoRoot, 'chat', 'summarizer.mjs')).href);

const { createSession, getSession, killAll, renameSession } = sessionManager;
const { appendEvent } = history;
const { messageEvent } = normalizer;
const { triggerSessionLabelSuggestion } = summarizer;

const session = await createSession(tempHome, fakeToolId, '', {});
await appendEvent(session.id, messageEvent('user', shellMetaPrompt));
await appendEvent(session.id, messageEvent('assistant', 'shell-false-ok'));

writeFileSync(argvCapturePath, '[]', 'utf8');

await triggerSessionLabelSuggestion(
  {
    id: session.id,
    folder: session.folder,
    name: session.name || '',
    group: session.group || '',
    description: session.description || '',
    sourceName: session.sourceName || '',
    autoRenamePending: session.autoRenamePending,
    tool: fakeToolId,
  },
  async (newName) => renameSession(session.id, newName, { lockTitle: false }),
);

assert.ok(!existsSync(shellProofPath), 'summarizer spawn must not invoke a shell');

killAll();
rmSync(tempHome, { recursive: true, force: true });

console.log('test-spawn-shell-false-contract: ok');
