#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  buildInstanceRuntimeCellEnvironment,
  ensureInstanceLarkCliBotProfile,
} from '../lib/instance-runtime-cell.mjs';

const instanceRoot = '/var/lib/remotelab-guests/muka2';
const projectRoot = '/opt/remotelab';
const runtimeEnv = buildInstanceRuntimeCellEnvironment({
  instanceRoot,
  projectRoot,
});

assert.equal(runtimeEnv.HOME, instanceRoot);
assert.equal(runtimeEnv.REMOTELAB_INSTANCE_ROOT, instanceRoot);
assert.equal(runtimeEnv.REMOTELAB_PROJECT_ROOT, projectRoot);
assert.equal(runtimeEnv.REMOTELAB_MACHINE_CODEX_HOME, undefined);
assert.equal(runtimeEnv.REMOTELAB_MACHINE_PI_AGENT_DIR, join(instanceRoot, '.pi', 'agent'));
assert.equal(runtimeEnv.LARKSUITE_CLI_CONFIG_DIR, join(instanceRoot, 'config', 'lark-cli'));
assert.equal(runtimeEnv.LARKSUITE_CLI_NO_UPDATE_NOTIFIER, '1');
assert.equal(runtimeEnv.LARKSUITE_CLI_NO_SKILLS_NOTIFIER, '1');

const calls = [];
const cliPolicy = { strictMode: 'off', defaultAs: 'user' };
const tempRoot = mkdtempSync(join(tmpdir(), 'remotelab-runtime-cell-'));
const testConfigDir = join(tempRoot, 'config', 'lark-cli');
try {
  await ensureInstanceLarkCliBotProfile({
    appId: 'cli_test',
    appSecret: 'secret_test',
    brand: 'feishu',
    profileName: 'bot-test',
    configDir: testConfigDir,
    cliPath: join(projectRoot, 'node_modules', '.bin', 'lark-cli'),
    runCommand: async (request) => {
      calls.push(request);
      if (request.args[1] === 'strict-mode') cliPolicy.strictMode = request.args[2];
      if (request.args[1] === 'default-as') cliPolicy.defaultAs = request.args[2];
      return { stdout: '', stderr: '' };
    },
  });
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

assert.deepEqual(cliPolicy, { strictMode: 'off', defaultAs: 'user' },
  'connector startup must preserve the CLI identity policy and the owner-selected default');
assert.deepEqual(
  calls.map((call) => call.args),
  [
    ['config', 'init', '--app-id', 'cli_test', '--app-secret-stdin', '--brand', 'feishu', '--name', 'bot-test'],
  ],
  'initialize the instance app credentials without pinning all CLI operations to Bot identity',
);
assert.equal(calls[0].stdin, 'secret_test\n');
for (const call of calls) {
  assert.equal(call.env.LARKSUITE_CLI_CONFIG_DIR, testConfigDir);
  assert.equal(call.env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER, '1');
  assert.equal(call.env.LARKSUITE_CLI_NO_SKILLS_NOTIFIER, '1');
  assert.equal(call.env.SECRET_SHOULD_NOT_SURVIVE, undefined);
}

const migrationRoot = mkdtempSync(join(tmpdir(), 'remotelab-runtime-cell-migration-'));
const migrationConfigDir = join(migrationRoot, 'instance', 'config', 'lark-cli');
const legacyConfigDir = join(migrationRoot, 'connector', 'lark-cli', 'bot-2');
const migrationCalls = [];
try {
  const { mkdirSync, writeFileSync } = await import('fs');
  mkdirSync(migrationConfigDir, { recursive: true });
  mkdirSync(legacyConfigDir, { recursive: true });
  writeFileSync(join(migrationConfigDir, 'config.json'), JSON.stringify({
    apps: [{ appId: 'cli_migrate', appSecret: { source: 'keychain', id: 'appsecret_cli_migrate' }, brand: 'feishu', users: [] }],
  }));
  writeFileSync(join(legacyConfigDir, 'config.json'), JSON.stringify({
    apps: [{
      appId: 'cli_migrate',
      appSecret: { source: 'keychain', id: 'appsecret_cli_migrate' },
      brand: 'feishu',
      users: [{ userName: 'Existing User', userOpenId: 'ou_existing' }],
    }],
  }));
  const migrated = await ensureInstanceLarkCliBotProfile({
    appId: 'cli_migrate',
    appSecret: 'secret_migrate',
    brand: 'feishu',
    profileName: 'bot-2',
    configDir: migrationConfigDir,
    legacyConfigDir,
    cliPath: join(projectRoot, 'node_modules', '.bin', 'lark-cli'),
    runCommand: async (request) => {
      migrationCalls.push(request);
      return { stdout: '', stderr: '' };
    },
  });
  assert.equal(migrated.profileName, 'bot-2');
  assert.equal(migrated.importedUsers, 1);
  assert.deepEqual(
    migrationCalls.map((call) => call.args),
    [
      ['profile', 'rename', 'cli_migrate', 'bot-2'],
      ['config', 'init', '--app-id', 'cli_migrate', '--app-secret-stdin', '--brand', 'feishu', '--name', 'bot-2'],
    ],
  );
  const migratedConfig = JSON.parse(await (await import('fs/promises')).readFile(join(migrationConfigDir, 'config.json'), 'utf8'));
  assert.deepEqual(migratedConfig.apps[0].users, [{ userName: 'Existing User', userOpenId: 'ou_existing' }]);
} finally {
  rmSync(migrationRoot, { recursive: true, force: true });
}

console.log('test-instance-runtime-cell: ok');
