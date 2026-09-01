#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-session-state-classifier-codex-home-'));
const tempBin = join(tempHome, 'bin');
const tempConfig = join(tempHome, 'config');
const tempMemory = join(tempHome, 'memory');
const envCapturePath = join(tempHome, 'captured-codex-home.txt');
const fakeToolId = 'fake-codex-home';
const machineCodexHome = join(tempHome, '.codex');

mkdirSync(tempBin, { recursive: true });
mkdirSync(tempConfig, { recursive: true });
mkdirSync(tempMemory, { recursive: true });

const fakeCodexPath = join(tempBin, 'codex');
writeFileSync(
  fakeCodexPath,
  `#!/usr/bin/env node
const fs = require('fs');
const outputPath = process.env.REMOTELAB_TEST_CODEX_HOME_CAPTURE;
const codexHome = process.env.CODEX_HOME || '';
if (outputPath) {
  fs.writeFileSync(outputPath, codexHome, 'utf8');
}
if (!codexHome) {
  console.error('CODEX_HOME missing');
  process.exit(1);
}
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fake-thread' }));
console.log(JSON.stringify({ type: 'turn.started' }));
console.log(JSON.stringify({
  type: 'item.completed',
  item: {
    type: 'agent_message',
    text: JSON.stringify({
      title: 'Codex Home Test',
      space: 'Product',
      group: 'Runtime',
      description: 'Verify session-state-classifier background Codex runs use the instance Codex home.',
    }),
  },
}));
console.log(JSON.stringify({
  type: 'turn.completed',
  usage: { input_tokens: 1, output_tokens: 1 },
}));
`,
  'utf8',
);
chmodSync(fakeCodexPath, 0o755);
writeFileSync(
  join(tempConfig, 'tools.json'),
  JSON.stringify(
    [
      {
        id: fakeToolId,
        name: 'Fake Codex Home',
        command: fakeCodexPath,
        runtimeFamily: 'codex-json',
        models: [{ id: 'fake-model', label: 'Fake model' }],
        reasoning: {
          kind: 'enum',
          label: 'Reasoning',
          levels: ['low'],
          default: 'low',
        },
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
process.env.REMOTELAB_TEST_CODEX_HOME_CAPTURE = envCapturePath;
delete process.env.REMOTELAB_INSTANCE_ROOT;
process.env.REMOTELAB_MACHINE_CODEX_HOME = machineCodexHome;
delete process.env.CODEX_HOME;

const sessionManager = await import(pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href);
const history = await import(pathToFileURL(join(repoRoot, 'chat', 'history.mjs')).href);
const normalizer = await import(pathToFileURL(join(repoRoot, 'chat', 'normalizer.mjs')).href);
const sessionStateClassifier = await import(pathToFileURL(join(repoRoot, 'chat', 'session-state-classifier.mjs')).href);

const { appendEvent } = history;
const { messageEvent } = normalizer;
const { createSession, killAll } = sessionManager;
const { triggerSessionStateSuggestion } = sessionStateClassifier;

const session = await createSession(tempHome, fakeToolId, '', {});
await appendEvent(session.id, messageEvent('user', 'Please verify the background Codex environment is wired correctly.'));
await appendEvent(session.id, messageEvent('assistant', 'I will verify the background Codex environment.'));

const result = await triggerSessionStateSuggestion({
  id: session.id,
  folder: session.folder,
  name: session.name || '',
  group: session.group || '',
  description: session.description || '',
  sourceName: session.sourceName || '',
  autoRenamePending: session.autoRenamePending,
  tool: fakeToolId,
});

const capturedCodexHome = readFileSync(envCapturePath, 'utf8').trim();
assert.equal(result?.ok, true, 'Session-state classifier should complete through the background Codex run');
assert.equal(result?.title, 'Codex Home Test');
assert.equal(capturedCodexHome, machineCodexHome, 'background Codex runs should use the instance Codex home');

killAll();
rmSync(tempHome, { recursive: true, force: true });

console.log('test-session-state-classifier-codex-home: ok');
