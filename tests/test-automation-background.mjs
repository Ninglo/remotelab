import assert from 'node:assert/strict';
import '../tests/isolate-test-environment.mjs';
import { listAutomationBackground } from '../chat/automation-background.mjs';

const mechanisms = [
  { id: 'timer', source: { kind: 'systemd', unit: 'example.timer' } },
  { id: 'unknown', source: { kind: 'systemd', unit: 'missing.service' } },
  { id: 'bad-unit', source: { kind: 'systemd', unit: 'bad;command.service' } },
  { id: 'held', source: { kind: 'environment', key: 'EXAMPLE', defaultEnabled: true } },
  { id: 'worker', source: { kind: 'environment', key: 'DISABLE_WORKER', invert: true } },
  { id: 'policy', source: { kind: 'json_flag', path: '/policy', key: 'enabled' } },
];
const calls = [];
const result = await listAutomationBackground({ path: '/descriptors',
  load: async path => JSON.stringify(path === '/descriptors' ? { mechanisms } : { enabled: true }),
  env: { EXAMPLE: 'false', DISABLE_WORKER: '1' },
  execute: async (cmd, args) => { calls.push([cmd, args]); return { stdout: args[1] === 'example.timer'
    ? 'LoadState=loaded\nActiveState=active\nSubState=waiting\nResult=success\n' : 'LoadState=not-found\nActiveState=inactive\n' }; } });
assert.deepEqual(result.map(x => x.state), ['running', 'unknown', 'unknown', 'disabled', 'disabled', 'configured']);
assert.equal(calls.length, 2, 'invalid descriptors cannot become shell commands');
assert.ok(calls.every(([cmd, args]) => cmd === 'systemctl' && args[0] === 'show'), 'projection never restarts or runs work');
assert.ok(result.every(x => !('actions' in x) && !('runs' in x)), 'source configuration cannot fabricate task execution');
assert.deepEqual(await listAutomationBackground({ load: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } }), []);
console.log('Background projection preserves source truth and never runs business work.');
