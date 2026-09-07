import assert from 'node:assert/strict';
import { getCurrentSystemdManagerScope, launchDetachedRunnerViaSystemd } from '../chat/run-launcher.mjs';

const systemCgroup = async () => '0::/system.slice/remotelab.service\n';
assert.equal(await getCurrentSystemdManagerScope({
  platform: 'linux', readFileImpl: systemCgroup,
  env: { REMOTELAB_RUNNER_SYSTEMD_SCOPE: 'user' },
}), 'user', 'an unprivileged controller must honor its configured user manager');
assert.equal(await getCurrentSystemdManagerScope({
  platform: 'linux', readFileImpl: systemCgroup, env: {},
}), 'system', 'without an override, preserve manager detection');
assert.equal(await getCurrentSystemdManagerScope({
  platform: 'darwin', env: { REMOTELAB_RUNNER_SYSTEMD_SCOPE: 'user' },
}), null);
await assert.rejects(getCurrentSystemdManagerScope({
  platform: 'linux', env: { REMOTELAB_RUNNER_SYSTEMD_SCOPE: 'typo' },
}), /must be user or system/);

const previous = process.env.REMOTELAB_RUNNER_SYSTEMD_SCOPE;
process.env.REMOTELAB_RUNNER_SYSTEMD_SCOPE = 'user';
try {
  const calls = [];
  const launched = await launchDetachedRunnerViaSystemd('scope-test', {
    execFileImpl: async (command, args, options) => {
      calls.push({ command, args, scope: options.env?.REMOTELAB_RUNNER_UNIT_SCOPE });
      return { stdout: command === 'systemctl' ? '4321\n' : '' };
    },
  });
  assert.equal(launched.unitScope, 'user', 'the default scope must be resolved before launch');
  assert.equal(launched.pid, 4321);
  assert.equal(calls[0].command, 'systemd-run');
  assert.equal(calls[0].args[0], '--user');
  assert.equal(calls[0].scope, 'user');
  assert.equal(calls[1].command, 'systemctl');
  assert.equal(calls[1].args[0], '--user', 'PID lookup must query the same manager as launch');
} finally {
  if (previous === undefined) delete process.env.REMOTELAB_RUNNER_SYSTEMD_SCOPE;
  else process.env.REMOTELAB_RUNNER_SYSTEMD_SCOPE = previous;
}
console.log('runner manager: configured user scope, async default and matching PID lookup passed');
