import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupAtomicTemps, readJson } from '../chat/fs-utils.mjs';
import { upsertConnectorMessageIndexRecord } from '../lib/connector-message-index.mjs';

const root = await mkdtemp(join(tmpdir(), 'json-read-failures-'));
try {
  const path = join(root, 'index.json');
  const fallback = { records: {} };
  assert.equal(await readJson(path, fallback), fallback, 'only absent files yield the default');
  const record = { connector: 'feishu', accountId: 'test', messageId: 'new', sessionId: 'session' };
  const corrupt = '{"records":{"saved":{"messageId":"keep"}}';
  await writeFile(path, corrupt);
  await assert.rejects(upsertConnectorMessageIndexRecord(path, record), SyntaxError);
  assert.equal(await readFile(path, 'utf8'), corrupt, 'a corrupt index cannot be replaced by a single record');
  const valid = JSON.stringify({ records: { saved: { messageId: 'keep' } } });
  await writeFile(path, valid);
  await chmod(path, 0);
  try {
    assert.notEqual(process.getuid?.(), 0, 'run this permission test as an unprivileged test user');
    await assert.rejects(upsertConnectorMessageIndexRecord(path, record), { code: 'EACCES' });
  } finally { await chmod(path, 0o600); }
  assert.equal(await readFile(path, 'utf8'), valid, 'permission failure leaves the original bytes intact');
  await assert.rejects(readJson(root, fallback), { code: 'EISDIR' });
  assert.equal((await readdir(root)).some(name => name.includes('.tmp-')), false, 'failed reads never create a replacement temporary file');

  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const deadPid = child.pid;
  await once(child, 'exit');
  const suffix = '12345678-1234-1234-1234-123456789abc';
  const dead = join(root, `index.json.tmp-${deadPid}-${suffix}`);
  const live = join(root, `index.json.tmp-${process.pid}-${suffix}`);
  const unknown = join(root, 'index.json.tmp-unknown');
  const link = join(root, `link.json.tmp-${deadPid}-${suffix}`);
  const nested = join(root, 'archive');
  await Promise.all([writeFile(dead, 'abandoned'), writeFile(live, 'in-flight'),
    writeFile(unknown, 'unknown'), symlink(path, link), mkdir(nested)]);
  await writeFile(join(nested, `old.json.tmp-${deadPid}-${suffix}`), 'historical');
  assert.deepEqual(await cleanupAtomicTemps(root), [dead]);
  assert.equal(await readFile(live, 'utf8'), 'in-flight');
  assert.equal(await readFile(path, 'utf8'), valid);
  assert.equal(await readFile(link, 'utf8'), valid, 'symlinks are never followed or removed');
  assert.equal((await readdir(nested)).length, 1, 'startup does not scan historical trees');
  assert.deepEqual(await cleanupAtomicTemps(root), []);
  assert.deepEqual(await cleanupAtomicTemps(join(root, 'absent')), []);
  console.log('PASS: ENOENT default; SyntaxError/EACCES/EISDIR propagate; failed index writes preserve bytes; only dead-owner atomic temps removed');
} finally { await rm(root, { recursive: true, force: true }); }
