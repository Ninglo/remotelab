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
assert.equal(runtimeEnv.REMOTELAB_MACHINE_CODEX_HOME, join(instanceRoot, '.codex'));
assert.equal(runtimeEnv.LARKSUITE_CLI_CONFIG_DIR, join(instanceRoot, 'config', 'lark-cli'));
assert.equal(runtimeEnv.LARKSUITE_CLI_NO_UPDATE_NOTIFIER, '1');
assert.equal(runtimeEnv.LARKSUITE_CLI_NO_SKILLS_NOTIFIER, '1');

const calls = [];
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
      return { stdout: '', stderr: '' };
    },
  });
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

assert.deepEqual(
  calls.map((call) => call.args),
  [
    ['config', 'init', '--app-id', 'cli_test', '--app-secret-stdin', '--brand', 'feishu'],
    ['config', 'strict-mode', 'bot', '--global'],
    ['config', 'default-as', 'bot'],
  ],
  'the instance profile should be initialized once and pinned to Bot identity for all in-cell tools',
);
assert.equal(calls[0].stdin, 'secret_test\n');
for (const call of calls) {
  assert.equal(call.env.LARKSUITE_CLI_CONFIG_DIR, testConfigDir);
  assert.equal(call.env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER, '1');
  assert.equal(call.env.LARKSUITE_CLI_NO_SKILLS_NOTIFIER, '1');
  assert.equal(call.env.SECRET_SHOULD_NOT_SURVIVE, undefined);
}

console.log('test-instance-runtime-cell: ok');
