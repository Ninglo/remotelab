import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('uv skips an unverified location, wrong filesystem, oversized cache and unexpected mount', async () => {
  for (const kind of ['unverified', 'filesystem', 'oversized', 'mounted', 'reportedPath']) {
    const seen = [];
    const result = await maintainDisk({ path: '/', uid: 1000,
      config: { caches: [{ kind: 'uv', path: '/cache/uv' }] },
      resolve: async p => kind === 'unverified' ? '/other' : p,
      inspect: async () => ({ isDirectory: () => true, uid: 1000, dev: kind === 'filesystem' ? 9 : 2, mode: 0o700 }),
      readDisk: async () => ({ device: 2, availableBytes: 0 }), checkUv: async () => kind !== 'mounted',
      run: async (tool, args) => {
        seen.push([tool, args]);
        if (tool === 'du') return { code: 0, stdout: `${kind === 'oversized' ? 11 * 1024 ** 3 : 8192}\t/cache/uv\n` };
        if (args[1] === 'dir') return { code: 0, stdout: '/different\n' };
        throw new Error('Unexpected cleanup command');
      } });
    assert.equal(result.actions[0].status, 'skipped', kind);
    assert.ok(seen.every(([tool, args]) => tool === 'du' || args[1] === 'dir'), kind);
  }
});

test('native uv prune frees an obsolete cache bucket, preserves unrelated bytes, and reports a no-op separately', async t => {
  try { execFileSync('uv', ['--version']); } catch { return t.skip('uv is not installed'); }
  if (process.platform !== 'linux') return t.skip('Linux mount validation');
  const dir = await mkdtemp(join(tmpdir(), 'disk-maintenance-test-'));
  try {
    const cache = join(dir, 'uv-cache');
    const outside = join(dir, 'keep');
    const obsolete = join(cache, 'wheels-v0');
    await mkdir(obsolete, { recursive: true, mode: 0o700 });
    await writeFile(join(cache, 'CACHEDIR.TAG'), 'Signature: 8a477f597d28d172789f06886806bc55\n');
    await writeFile(join(cache, '.gitignore'), '*\n');
    await writeFile(outside, 'outside cache');
    await symlink(outside, join(obsolete, 'outside-link'));
    await writeFile(join(obsolete, 'old'), Buffer.alloc(4 * 1024 ** 2));
    const before = await stat(join(obsolete, 'old'));
    const options = { path: dir, config: { caches: [{ kind: 'uv', path: cache }] },
      run: async (tool, args) => {
        assert.ok(tool === 'du' || tool === 'uv');
        assert.ok(!args.includes('--force'));
        const r = spawnSync(tool, args, { env: { ...process.env, UV_CACHE_DIR: cache }, encoding: 'utf8' });
        return { code: r.status, stdout: r.stdout, stderr: r.stderr };
      } };
    const first = await maintainDisk(options);
    assert.ok(before.blocks * 512 >= 4 * 1024 ** 2);
    assert.equal(first.actions[0].status, 'cleaned');
    assert.match(first.actions[0].output, /Removed/);
    await assert.rejects(stat(obsolete), { code: 'ENOENT' });
    assert.equal(await readFile(outside, 'utf8'), 'outside cache');
    const second = await maintainDisk(options);
    assert.equal(second.actions[0].status, 'unchanged');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('partial failure is retained and cannot fall through to recursive deletion or another purge', async () => {
  const f = fixture(), run = f.options.run;
  f.options.run = async (file, args) => args.includes('clean')
    ? { code: 'ETIMEDOUT', stdout: '', stderr: 'timed out', killed: true } : run(file, args);
  const result = await maintainDisk(f.options);
  assert.equal(result.actions.length, 1); assert.equal(result.actions[0].status, 'failed');
  assert.equal(f.purges.length, 0);
});
