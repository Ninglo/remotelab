import test from 'node:test';
import assert from 'node:assert/strict';
import { maintainDisk } from '../chat/disk-maintenance.mjs';

function fixture({ busy = false, foreign = false, nested = false, open = false, oversized = false, toolMismatch = false } = {}) {
  const purges = [];
  const result = (stdout = '', code = 0) => ({ code, stdout, stderr: '' });
  return { purges, options: { path: '/', uid: 1000,
    config: { caches: [{ kind: 'npm', path: '/cache/npm' }, { kind: 'pip', path: '/cache/pip' }] },
    inspect: async () => ({ isDirectory: () => true, uid: foreign ? 1001 : 1000, dev: 2 }),
    resolve: async p => p,
    readDisk: async () => ({ device: 2, availableBytes: (10 + purges.length) * 1024 ** 3, usedPercent: 90, inodeUsedPercent: 1 }),
    run: async (file, args) => {
      if (file === 'find') return result(args.includes('-printf') ? `${nested ? 3 : 2}\n` : '');
      if (file === 'du') return result(`${(oversized ? 11 : 1) * 1024 ** 3}\t/cache\n`);
      if (file === 'ps') return result(busy ? 'python3 -m pip install package\n' : 'node chat-server.mjs\n');
      if (file === 'lsof') return result(open ? 'npm 123 open-file\n' : '', open ? 0 : 1);
      if (args.includes('get') || args.includes('dir')) return result(toolMismatch ? '/elsewhere\n' : file === 'npm' ? '/cache/npm\n' : '/cache/pip\n');
      if (args.includes('clean') || args.includes('purge')) { purges.push([file, args]); return result('cleaned\n'); }
      throw new Error(`Unexpected command: ${file}`);
    } } };
}

test('only official cache commands run; physical deltas and each result are recorded', async () => {
  const f = fixture(); const result = await maintainDisk(f.options);
  assert.equal(f.purges.length, 2);
  assert.deepEqual(f.purges[0], ['npm', ['--cache', '/cache/npm', 'cache', 'clean', '--force']]);
  assert.deepEqual(f.purges[1], ['python3', ['-m', 'pip', '--cache-dir', '/cache/pip', 'cache', 'purge']]);
  assert.equal(result.availableBytesDelta, 2 * 1024 ** 3);
  assert.ok(result.actions.every(a => a.status === 'cleaned'));
});

for (const boundary of ['busy', 'foreign', 'nested', 'open', 'oversized', 'toolMismatch']) {
  test(`${boundary} cache is observed without deletion`, async () => {
    const f = fixture({ [boundary]: true });
    const result = await maintainDisk(f.options);
    assert.equal(f.purges.length, 0);
    assert.ok(result.actions.every(a => a.status === 'skipped' && a.reason));
  });
}

test('partial failure is retained and cannot fall through to recursive deletion or another purge', async () => {
  const f = fixture(), run = f.options.run;
  f.options.run = async (file, args) => args.includes('clean')
    ? { code: 'ETIMEDOUT', stdout: '', stderr: 'timed out', killed: true } : run(file, args);
  const result = await maintainDisk(f.options);
  assert.equal(result.actions.length, 1); assert.equal(result.actions[0].status, 'failed');
  assert.equal(f.purges.length, 0);
});
