import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createCompanionLibraryReader, COMPANION_ACTION_INTERVAL_MS } from '../display/companion-library.mjs';

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
    const selected = await reader.select('pet', i * COMPANION_ACTION_INTERVAL_MS);
    seen.add(selected.action.name); assert.equal(selected.total, 106);
    if (selected.action.name === 'Action 0') index = i;
    assert.equal(selected.frames, 101);
    assert.equal(selected.tick, i);
  }
  assert.equal(seen.size, 106, 'every action is visited, without truncating the catalog');
  assert.equal(COMPANION_ACTION_INTERVAL_MS, 20_000);
  assert.deepEqual(await reader.select('pet', 60001), await reader.select('pet', 79999), 'stable within one 20-second slot');
  const withinMinute = await Promise.all([60000, 80000, 100000].map(at => reader.select('pet', at)));
  assert.equal(new Set(withinMinute.map(x => x.action.name)).size, 3, 'three different actions within a minute');
  for (const selected of withinMinute) {
    assert.equal(selected.durationMs, 10100, 'source playback speed and complete duration stay unchanged');
    assert.equal(selected.frames, 101);
  }
  await assert.rejects(reader.select('../pet'), /library ID/);
  const invalid = join(root, 'escape'); await mkdir(invalid);
  await symlink(join(dir, '0.gif'), join(invalid, 'outside.gif'));
  await writeFile(join(invalid, 'manifest.json'), JSON.stringify({ version: 1, id: 'escape', actions: [{ ...actions[0], file: 'outside.gif' }] }));
  await assert.rejects(reader.select('escape', 0), /outside/);
  await writeFile(join(dir, '0.gif'), 'changed');
  const fresh = createCompanionLibraryReader(root);
  await assert.rejects(fresh.select('pet', index * COMPANION_ACTION_INTERVAL_MS), /verification/);
  console.log('PASS 106-action coverage, 20-second rotation independent of clock, original duration, path boundary, asset hash and player limits');
} finally { await rm(root, { recursive: true, force: true }); }
