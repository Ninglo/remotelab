#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const sandboxHome = mkdtempSync(join(tmpdir(), 'remotelab-guest-manager-context-'));
const instanceRoot = join(sandboxHome, 'instance-data');
const configDir = join(instanceRoot, 'config');
const memoryDir = join(instanceRoot, 'memory');
const workspaceDir = join(instanceRoot, 'workspace');
const localBin = join(sandboxHome, '.local', 'bin');

mkdirSync(configDir, { recursive: true });
mkdirSync(memoryDir, { recursive: true });
mkdirSync(workspaceDir, { recursive: true });
mkdirSync(localBin, { recursive: true });

writeFileSync(
  join(configDir, 'auth.json'),
  JSON.stringify({ token: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' }, null, 2),
  'utf8',
);
writeFileSync(
  join(configDir, 'tools.json'),
  JSON.stringify([
    {
      id: 'fake-codex',
      name: 'Fake Codex',
      command: 'fake-codex',
      runtimeFamily: 'codex-json',
      models: [{ id: 'fake-model', label: 'Fake model', defaultEffort: 'low' }],
      reasoning: { kind: 'enum', label: 'Thinking', levels: ['low'], default: 'low' },
    },
  ], null, 2),
  'utf8',
);
writeFileSync(join(localBin, 'fake-codex'), '#!/usr/bin/env bash\nexit 0\n', 'utf8');
chmodSync(join(localBin, 'fake-codex'), 0o755);

const previousHome = process.env.HOME;
const previousInstanceRoot = process.env.REMOTELAB_INSTANCE_ROOT;
const previousPath = process.env.PATH;

process.env.HOME = sandboxHome;
process.env.REMOTELAB_INSTANCE_ROOT = instanceRoot;
process.env.PATH = `${localBin}:${process.env.PATH || ''}`;
process.chdir(repoRoot);

try {
  const sessionManagerUrl = pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href;
  const { createSession, getHistory, sendMessage } = await import(`${sessionManagerUrl}?t=${Date.now()}`);

  const session = await createSession(workspaceDir, 'fake-codex', 'Guest manager context boundary');
  assert.ok(session?.id, 'session should be created');

  await sendMessage(session.id, 'Check guest manager context persistence.', []);
  await new Promise((resolve) => setTimeout(resolve, 150));

  const history = await getHistory(session.id);
  assert.ok(
    history.some((event) => event?.type === 'message' && event.role === 'user'),
    'user message should still be recorded',
  );
  assert.equal(
    history.some((event) => event?.type === 'manager_context'),
    false,
    'guest history should not persist hidden manager turn context blocks',
  );
} finally {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;

  if (previousInstanceRoot === undefined) delete process.env.REMOTELAB_INSTANCE_ROOT;
  else process.env.REMOTELAB_INSTANCE_ROOT = previousInstanceRoot;

  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;

  rmSync(sandboxHome, { recursive: true, force: true });
}

console.log('test-guest-manager-context-boundary: ok');
