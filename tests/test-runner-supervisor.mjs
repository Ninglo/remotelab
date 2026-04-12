#!/usr/bin/env node
import assert from 'assert/strict';

import {
  DETACHED_RUNNER_PROCESS_LAUNCH_MODE,
  DETACHED_RUNNER_SYSTEMD_LAUNCH_MODE,
  buildDetachedRunnerUnitName,
  createDetachedRunnerSpawner,
  detectSystemdManagerScope,
  launchDetachedRunnerViaSystemd,
} from '../chat/runner-supervisor.mjs';

assert.equal(buildDetachedRunnerUnitName('run_abc/123'), 'remotelab-runner-run_abc_123');
assert.equal(detectSystemdManagerScope('0::/system.slice/remotelab.service\n'), 'system');
assert.equal(
  detectSystemdManagerScope('0::/user.slice/user-1000.slice/user@1000.service/app.slice/remotelab-chat.service\n'),
  'user',
);
assert.equal(detectSystemdManagerScope('0::/init.scope\n'), null);

{
  const calls = [];
  const result = await launchDetachedRunnerViaSystemd('run_demo/123', {
    scope: 'system',
    workingDirectory: '/opt/remotelab',
    processExecPath: '/usr/bin/node',
    runnerScriptPath: '/opt/remotelab/chat/runner-sidecar.mjs',
    execFileImpl: async (command, args) => {
      calls.push({ command, args });
      if (command === 'systemd-run') {
        return { stdout: '', stderr: '' };
      }
      if (command === 'systemctl') {
        return { stdout: '43210\n', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command}`);
    },
  });

  assert.equal(result.pid, 43210);
  assert.equal(result.unitName, 'remotelab-runner-run_demo_123');
  assert.equal(result.unitScope, 'system');
  assert.equal(result.launchMode, DETACHED_RUNNER_SYSTEMD_LAUNCH_MODE);
  assert.equal(calls[0].command, 'systemd-run');
  assert.deepEqual(calls[0].args.slice(0, 7), [
    '--quiet',
    '--collect',
    '--no-block',
    '--service-type=exec',
    '--unit',
    'remotelab-runner-run_demo_123',
    '--working-directory',
  ]);
  assert.ok(calls[0].args.includes('REMOTELAB_RUNNER_UNIT_NAME=remotelab-runner-run_demo_123'));
  assert.ok(calls[0].args.includes(`REMOTELAB_RUNNER_LAUNCH_MODE=${DETACHED_RUNNER_SYSTEMD_LAUNCH_MODE}`));
  assert.equal(calls[1].command, 'systemctl');
  assert.deepEqual(calls[1].args, ['show', '--property=MainPID', '--value', 'remotelab-runner-run_demo_123']);
}

{
  let spawnInvocation = null;
  let unrefCalled = false;
  const previousSandbox = process.env.IS_SANDBOX;
  process.env.IS_SANDBOX = '';
  const spawner = createDetachedRunnerSpawner({
    getScopeImpl: () => 'system',
    execFileImpl: async (command) => {
      if (command === 'systemd-run') {
        throw new Error('synthetic systemd-run failure');
      }
      throw new Error(`Unexpected command: ${command}`);
    },
    spawnImpl: (command, args, options) => {
      spawnInvocation = { command, args, options };
      return {
        pid: 65432,
        unref() {
          unrefCalled = true;
        },
      };
    },
  });

  const result = await spawner('run_fallback');
  assert.equal(result.pid, 65432);
  assert.equal(result.unitName, null);
  assert.equal(result.unitScope, null);
  assert.equal(result.launchMode, DETACHED_RUNNER_PROCESS_LAUNCH_MODE);
  assert.equal(spawnInvocation.command, process.execPath);
  assert.deepEqual(spawnInvocation.args, ['/opt/remotelab/chat/runner-sidecar.mjs', 'run_fallback']);
  assert.equal(spawnInvocation.options.detached, true);
  assert.equal(spawnInvocation.options.stdio, 'ignore');
  assert.equal(
    spawnInvocation.options.env.REMOTELAB_RUNNER_LAUNCH_MODE,
    DETACHED_RUNNER_PROCESS_LAUNCH_MODE,
  );
  assert.equal(spawnInvocation.options.env.IS_SANDBOX, '1');
  assert.equal(unrefCalled, true);
  process.env.IS_SANDBOX = '0';
  spawnInvocation = null;
  await spawner('run_fallback_disabled');
  assert.equal(spawnInvocation.options.env.IS_SANDBOX, '0');
  process.env.IS_SANDBOX = previousSandbox;
}

console.log('test-runner-supervisor: ok');
