import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { withFileLock } from '../lib/file-lock.mjs';
const exec = promisify(execFile);

test('same-file writers serialize, unrelated locks overlap and exceptions release', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'file-lock-'));
  try {
    const file = join(dir, "test file's counter");
    await writeFile(file, '0');
    await Promise.all(Array.from({ length: 12 }, () => withFileLock(file, async () => {
      const n = Number(await readFile(file, 'utf8'));
      await writeFile(file, String(n + 1));
    })));
    assert.equal(await readFile(file, 'utf8'), '12');
    let entered = 0, release;
    const both = new Promise(resolve => { release = resolve; });
    await Promise.all(['a', 'b'].map(key => withFileLock(join(dir, key), async () => {
      if (++entered === 2) release();
      await both;
    })));
    await assert.rejects(withFileLock(file, () => { throw new Error('synthetic failure'); }), /synthetic failure/);
    assert.equal(await withFileLock(file, () => 'recovered'), 'recovered');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('ordinary flock interoperation and parent SIGKILL release', { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'file-lock-death-'));
  const file = join(dir, 'counter');
  const url = new URL('../lib/file-lock.mjs', import.meta.url).href;
  let child;
  try {
    child = spawn(process.execPath, ['--input-type=module', '-e',
      `import {withFileLock} from ${JSON.stringify(url)}; await withFileLock(${JSON.stringify(file)}, async()=>{console.log('held');await new Promise(()=>{});});`],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    await once(child.stdout, 'data');
    await assert.rejects(exec('flock', ['-n', file + '.lock', 'true']), error => error.code === 1);
    const closed = once(child, 'close'); child.kill('SIGKILL'); await closed;
    await exec('flock', ['-w', '2', file + '.lock', 'true']);
    assert.equal(await withFileLock(file, () => 'next writer'), 'next writer');
    // Completed one-shot CLIs must exit without a helper/channel keeping them up.
    await exec(process.execPath, ['--input-type=module', '-e',
      `import {withFileLock} from ${JSON.stringify(url)}; await withFileLock(${JSON.stringify(file)},()=>42);`], { timeout: 3000 });
  } finally { child?.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }); }
});

test('missing flock rejects without retaining the caller', { timeout: 5000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'file-lock-missing-'));
  const url = new URL('../lib/file-lock.mjs', import.meta.url).href;
  try {
    await exec(process.execPath, ['--input-type=module', '-e',
      `import assert from 'node:assert/strict'; import {withFileLock} from ${JSON.stringify(url)}; await assert.rejects(withFileLock(${JSON.stringify(join(dir, 'x'))},()=>42),/ENOENT/);`],
    { env: { ...process.env, PATH: dir }, timeout: 3000 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
