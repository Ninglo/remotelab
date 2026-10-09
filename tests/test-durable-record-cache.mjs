#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = fs.mkdtempSync(join(tmpdir(), 'remotelab-record-cache-'));
const original = fs.promises.readFile;
let reads = 0;
fs.promises.readFile = async function (path, ...args) {
  if (String(path).startsWith(root)) reads++;
  return original.call(this, path, ...args);
};
syncBuiltinESMExports();

try {
  const { createRecordStore, writeDurableJson } = await import('../lib/durable-records.mjs');
  const store = createRecordStore(root), otherWriter = createRecordStore(root);
  const key = 'a'.repeat(24);
  await store.mutate(key, () => ({ sequence: 1, nested: { state: 'original' }, body: 'large string '.repeat(100_000) }));
  const first = await store.get(key);
  const initialReads = reads;
  first.nested.state = 'caller mutation';
  const list = await store.active();
  assert.equal(list[0].nested.state, 'original', 'a returned object cannot mutate the read cache');
  list[0].nested.state = 'list mutation';
  assert.equal((await store.get(key)).nested.state, 'original');
  assert.equal(reads, initialReads, 'unchanged records are not reread or reparsed on get/list');

  await otherWriter.mutate(key, current => ({ ...current, nested: { state: 'external writer' } }));
  assert.equal((await store.get(key)).nested.state, 'external writer', 'another store writer invalidates cached data');
  assert(reads > initialReads);
  await otherWriter.archive(key);
  assert.equal((await store.active()).length, 0, 'archival removes a cached active record');
  assert.equal((await store.get(key)).nested.state, 'external writer', 'archived lookup stays available');

  await writeDurableJson(join(root, 'archive', key + '.json'), { schema: 2, key });
  await assert.rejects(store.get(key), /Unsupported runtime schema/, 'external replacement cannot bypass schema validation');
  fs.rmSync(join(root, 'archive', key + '.json'));
  assert.equal(await store.get(key), null, 'deletion cannot leave a stale cached value');
  console.log('Durable-record caching: unchanged reads, caller isolation, external writes, archival, schema validation and deletion passed.');
} finally {
  fs.promises.readFile = original;
  syncBuiltinESMExports();
  fs.rmSync(root, { recursive: true, force: true });
}
