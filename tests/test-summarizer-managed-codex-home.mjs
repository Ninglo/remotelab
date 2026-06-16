#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-summarizer-codex-home-'));
const tempBin = join(tempHome, 'bin');
const tempConfig = join(tempHome, 'config');
const tempMemory = join(tempHome, 'memory');
const envCapturePath = join(tempHome, 'captured-codex-home.txt');
const fakeToolId = 'fake-codex-managed-home';

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
      title: 'Managed Home Test',
      group: 'Managed Home',
      description: 'Verify summarizer background Codex runs inherit the managed runtime home.',
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
        name: 'Fake Codex Managed Home',
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

const sessionManager = await import(pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href);
const history = await import(pathToFileURL(join(repoRoot, 'chat', 'history.mjs')).href);
const normalizer = await import(pathToFileURL(join(repoRoot, 'chat', 'normalizer.mjs')).href);
const summarizer = await import(pathToFileURL(join(repoRoot, 'chat', 'summarizer.mjs')).href);

const { appendEvent } = history;
const { messageEvent } = normalizer;
const { createSession, getSession, killAll, renameSession } = sessionManager;
const { triggerSessionLabelSuggestion } = summarizer;

const session = await createSession(tempHome, fakeToolId, '', {});
await appendEvent(session.id, messageEvent('user', 'Please verify the background Codex environment is wired correctly.'));
await appendEvent(session.id, messageEvent('assistant', 'I will verify the background Codex environment.'));

const result = await triggerSessionLabelSuggestion(
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

const updated = await getSession(session.id);
const capturedCodexHome = readFileSync(envCapturePath, 'utf8').trim();
const expectedManagedHome = join(tempConfig, 'provider-runtime-homes', 'codex');

assert.equal(result?.rename?.renamed, true, 'summarizer should be able to rename via Codex background run');
assert.equal(updated?.name, result?.title, 'session title should match the summarizer-applied title');
assert.equal(updated?.autoRenamePending, false);
assert.equal(capturedCodexHome, expectedManagedHome, 'background summarizer codex run should receive managed CODEX_HOME');

killAll();
rmSync(tempHome, { recursive: true, force: true });

console.log('test-summarizer-managed-codex-home: ok');
