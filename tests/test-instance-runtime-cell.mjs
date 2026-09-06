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
    ['config', 'init', '--app-id', 'cli_test', '--app-secret-stdin', '--brand', 'feishu'],
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

console.log('test-instance-runtime-cell: ok');
