#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const sandboxHome = mkdtempSync(join(tmpdir(), 'remotelab-guest-mailbox-bootstrap-'));
const instanceRoot = join(sandboxHome, '.remotelab', 'instances', 'trial-mailbox');
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
  const { getOwnerBootstrapSessionDefinitions } = await import('../chat/bootstrap-sessions.mjs');

  const definitions = await getOwnerBootstrapSessionDefinitions();
  const names = definitions.map((definition) => definition.name);
  const welcome = definitions.find(
    (definition) => definition.externalTriggerId === 'owner_bootstrap:welcome',
  );

  assert.ok(welcome, 'guest bootstrap should still define the welcome session');
  assert.equal(
    Array.isArray(welcome.extraMessages) ? welcome.extraMessages.length : 0,
    0,
    'guest welcome should not append owner-backed mailbox hints by default',
  );
  assert.ok(
    names.includes('[引导] 连接本地文件，把旧电脑资料迁进这个实例'),
    'guest bootstrap should still include the local migration guide',
  );
  assert.ok(
    !names.includes('[示例] 发邮件进来后，自动开新会话继续处理'),
    'guest bootstrap should hide the inbound-email showcase by default',
  );
  assert.ok(
    !names.includes('[示例] 把一份 Excel / CSV 清洗后回给我') && !names.includes('[示例] 每天早上把行业热点整理后发到我邮箱'),
    'guest bootstrap should avoid loading extra showcase context by default',
  );
} finally {
  rmSync(sandboxHome, { recursive: true, force: true });
}

console.log('test-guest-bootstrap-mailbox-boundary: ok');
