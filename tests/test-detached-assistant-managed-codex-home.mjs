#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-detached-codex-home-'));
const tempBin = join(tempHome, 'bin');
const tempConfig = join(tempHome, 'config');
const tempMemory = join(tempHome, 'memory');
const envCapturePath = join(tempHome, 'captured-codex-home.txt');
const fakeToolId = 'fake-detached-codex-home';

mkdirSync(tempBin, { recursive: true });
mkdirSync(tempConfig, { recursive: true });
mkdirSync(tempMemory, { recursive: true });

const fakeCodexPath = join(tempBin, 'fake-detached-codex');
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
    text: 'Detached helper ok',
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
        name: 'Fake Detached Codex Home',
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
delete process.env.CODEX_HOME;

const detached = await import(pathToFileURL(join(repoRoot, 'chat', 'session-detached-assistant.mjs')).href);

const { runDetachedAssistantPrompt } = detached;
const response = await runDetachedAssistantPrompt(
  {
    id: 'session_detached',
    folder: tempHome,
    tool: fakeToolId,
  },
  'Verify the detached helper environment.',
);

const capturedCodexHome = readFileSync(envCapturePath, 'utf8').trim();
const expectedManagedHome = join(tempConfig, 'provider-runtime-homes', 'codex');

assert.equal(response, 'Detached helper ok');
assert.equal(capturedCodexHome, expectedManagedHome, 'detached assistant codex run should receive managed CODEX_HOME');

rmSync(tempHome, { recursive: true, force: true });

console.log('test-detached-assistant-managed-codex-home: ok');
