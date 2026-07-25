#!/usr/bin/env node
import assert from 'assert/strict';
import { spawnSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const repoRoot = process.cwd();
const helperPath = join(repoRoot, 'scripts', 'feishu-connector-instance.sh');
const tempRoot = mkdtempSync(join(tmpdir(), 'remotelab-feishu-instance-'));

try {
  const configPath = join(tempRoot, 'bot-b', 'config.json');
  const storageDir = join(tempRoot, 'bot-b-state');
  const fakeBin = join(tempRoot, 'bin');
  const systemctlLog = join(tempRoot, 'systemctl.log');
  mkdirSync(join(tempRoot, 'bot-b'), { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(configPath, JSON.stringify({
    appId: 'cli_bot_b',
    appSecret: 'secret',
    storageDir,
  }));
  writeFileSync(
    join(fakeBin, 'systemctl'),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${systemctlLog}"\nexit 0\n`,
  );
  chmodSync(join(fakeBin, 'systemctl'), 0o755);

  const status = spawnSync(helperPath, ['status', '--config', configPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
    },
    encoding: 'utf8',
  });
  assert.equal(status.status, 1);
  assert.match(status.stdout, /feishu connector is not running/);
  assert.match(status.stdout, new RegExp(storageDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(status.stderr, '');

  mkdirSync(storageDir, { recursive: true });
  writeFileSync(join(storageDir, 'connector.pid'), `${process.pid}\n`);
  const mismatch = spawnSync(helperPath, ['restart', '--config', configPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
    },
    encoding: 'utf8',
  });
  assert.equal(mismatch.status, 2);
  assert.match(mismatch.stderr, /refusing to operate/);

  console.log('feishu connector instance tests passed');
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
