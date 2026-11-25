import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createDetachedRunnerSpawner, spawnDetachedRunnerInCgroup } from '../chat/run-launcher.mjs';

const cgroupProcs = '/sys/fs/cgroup/system.slice/example.service/runner-bulk/cgroup.procs';
let spawns = 0;
function spawnStub(output) {
  return (program, args, opts) => {
    spawns += 1;
    assert.equal(program, '/bin/sh');
    assert.equal(args[3], cgroupProcs);
    assert.equal(args.at(-1), 'run_cgroup_test');
    assert.equal(opts.detached, true);
    const child = Object.assign(new EventEmitter(), { pid: 42, stdio: [null, null, null, new PassThrough()] });
    child.kill = () => { child.killed = true; };
    child.unref = () => { assert.ok(!child.killed); };
    queueMicrotask(() => child.stdio[3].end(output));
    return child;
  };
}
const makeLauncher = output => createDetachedRunnerSpawner({
  env: { REMOTELAB_RUNNER_CGROUP_PROCS: cgroupProcs }, spawnImpl: spawnStub(output),
  getScopeImpl: () => { throw new Error('must not fall back to systemd or an unisolated process'); },
});
assert.equal((await makeLauncher('joined\n')('run_cgroup_test')).pid, 42);
await assert.rejects(makeLauncher('')('run_cgroup_test'), /could not join/);
await assert.rejects(spawnDetachedRunnerInCgroup('run_cgroup_test', { cgroupProcs: '/tmp/cgroup.procs', spawnImpl: spawnStub('') }), /Invalid/);
assert.equal(spawns, 2);
console.log('runner cgroup: placement acknowledgement, fail-closed, and invalid path passed');
