import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createCompanionLibraryReader } from '../display/companion-library.mjs';

const root = await mkdtemp(join(tmpdir(), 'display-library-'));
try {
  const dir = join(root, 'pet'); await mkdir(dir);
  const actions = [];
  for (let i = 0; i < 106; i++) {
    const bytes = Buffer.from(`GIF89a fixture ${i}`);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const file = `${i}.gif`; await writeFile(join(dir, file), bytes);
    actions.push({ name: `Action ${i}`, file, sha256, frames: 101, durationMs: 10100 });
  }
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ version: 1, id: 'pet', actions }));
  const reader = createCompanionLibraryReader(root);
  const seen = new Set();
  let index = -1;
  for (let i = 0; i < 106; i++) {
    const selected = await reader.select('pet', i * 60000);
    seen.add(selected.action.name); assert.equal(selected.total, 106);
    if (selected.action.name === 'Action 0') index = i;
    assert.equal(selected.frames, 101);
  }
  assert.equal(seen.size, 106, 'every action is visited, without truncating the catalog');
  assert.deepEqual(await reader.select('pet', 60001), await reader.select('pet', 60999), 'stable within the minute');
  await assert.rejects(reader.select('../pet'), /library ID/);
  const invalid = join(root, 'escape'); await mkdir(invalid);
  await symlink(join(dir, '0.gif'), join(invalid, 'outside.gif'));
  await writeFile(join(invalid, 'manifest.json'), JSON.stringify({ version: 1, id: 'escape', actions: [{ ...actions[0], file: 'outside.gif' }] }));
  await assert.rejects(reader.select('escape', 0), /outside/);
  await writeFile(join(dir, '0.gif'), 'changed');
  const fresh = createCompanionLibraryReader(root);
  await assert.rejects(fresh.select('pet', index * 60000), /verification/);
  console.log('PASS 106-action coverage, stable selection, path boundary, asset hash and player limits');
} finally { await rm(root, { recursive: true, force: true }); }
