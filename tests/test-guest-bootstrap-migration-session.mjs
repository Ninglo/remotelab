#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const sandboxHome = mkdtempSync(join(tmpdir(), 'remotelab-guest-bootstrap-'));
const instanceRoot = join(sandboxHome, '.remotelab', 'instances', 'trial-migrate');
const configDir = join(instanceRoot, 'config');
const memoryDir = join(instanceRoot, 'memory');
const localBin = join(sandboxHome, '.local', 'bin');

mkdirSync(configDir, { recursive: true });
mkdirSync(memoryDir, { recursive: true });
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
      id: 'micro-agent',
      name: 'Micro Agent',
      visibility: 'private',
      toolProfile: 'micro-agent',
      command: 'fake-codex',
      runtimeFamily: 'codex-json',
      models: [{ id: 'fake-model', label: 'Fake model' }],
      reasoning: { kind: 'none', label: 'Thinking' },
    },
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

process.env.HOME = sandboxHome;
process.env.REMOTELAB_INSTANCE_ROOT = instanceRoot;
process.env.CHAT_PORT = '43123';
process.env.REMOTELAB_BRIDGE_BASE_URL = '';
process.env.REMOTELAB_PUBLIC_BASE_URL = '';
process.chdir(repoRoot);

try {
  const { backfillOwnerBootstrapSessions } = await import('../chat/bootstrap-sessions.mjs');
  const { listSessions } = await import('../chat/session-manager.mjs');
  const { readEventsAfter } = await import('../chat/history.mjs');

  const result = await backfillOwnerBootstrapSessions();
  assert.ok(result?.welcomeSession?.id, 'guest bootstrap should create a welcome session');

  const sessions = await listSessions();
  const sessionNames = sessions.map((session) => session.name);
  assert.equal(sessionNames[0], 'Welcome', 'guest bootstrap should keep Welcome first');
  assert.equal(
    sessionNames[1],
    '[引导] 连接本地文件，把旧电脑资料迁进这个实例',
    'guest bootstrap should insert the local migration guide right after Welcome',
  );
  assert.ok(
    sessionNames.includes('[示例] 上传一份表格，我把清洗后的文件回给你'),
    'guest bootstrap should keep the existing showcase sessions',
  );

  const migrationSession = sessions.find((session) => session.name === '[引导] 连接本地文件，把旧电脑资料迁进这个实例');
  assert.ok(migrationSession, 'guest bootstrap should create the migration guide session');
  assert.equal(migrationSession.pinned, true, 'migration guide should be pinned');
  assert.equal(migrationSession.entryMode, 'read', 'migration guide should open in read mode');
  assert.equal(migrationSession.sidebarOrder, 2, 'migration guide should sit directly after Welcome');

  const events = await readEventsAfter(migrationSession.id, 0, { includeBodies: true });
  const assistantMessages = events
    .filter((event) => event?.type === 'message' && event?.role === 'assistant')
    .map((event) => event.content || '')
    .join('\n\n');

  assert.match(assistantMessages, /本地迁移入口|旧电脑里的项目上下文/u, 'migration guide should explain the local bridge purpose');
  assert.match(assistantMessages, /安装一次本地助手|按需把文件拉进当前实例/u, 'migration guide should explain the install-once migration flow');
  assert.match(assistantMessages, /整机里找 xxx 项目|本机哪个盘、哪个目录附近/u, 'migration guide should explain whole-machine migration guidance');
} finally {
  rmSync(sandboxHome, { recursive: true, force: true });
}

console.log('test-guest-bootstrap-migration-session: ok');
