#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonAtomic, writeTextAtomic } from '../chat/fs-utils.mjs';

const root = await mkdtemp(join(tmpdir(), 'remotelab-atomic-write-'));
const originalNow = Date.now;
try {
  Date.now = () => 123456;
  const jsonPath = join(root, 'auth.json');
  const textPath = join(root, 'state.txt');
  await Promise.all(Array.from({ length: 40 }, (_, index) => Promise.all([
    writeJsonAtomic(jsonPath, { index }),
    writeTextAtomic(textPath, String(index)),
  ])));
  const saved = JSON.parse(await readFile(jsonPath, 'utf8'));
  const text = await readFile(textPath, 'utf8');
  assert.ok(Number.isInteger(saved.index) && saved.index >= 0 && saved.index < 40);
  assert.ok(Number.isInteger(Number(text)) && Number(text) >= 0 && Number(text) < 40);
} finally {
  Date.now = originalNow;
  await rm(root, { recursive: true, force: true });
}
console.log('test-fs-utils-concurrent-atomic-write: ok');
