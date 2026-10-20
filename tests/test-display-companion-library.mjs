import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createCompanionLibraryReader, nextCompanionAction } from '../display/companion-library.mjs';

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
  for (const action of actions) {
    const selected = await reader.select('pet', action.name);
    assert.equal(selected.action.name, action.name);
    assert.equal(selected.total, 106);
    assert.equal(selected.frames, 101);
    assert.equal(selected.durationMs, 10100);
  }
  for (let i = 0; i < 100; i++) assert.notEqual(await reader.next('pet', 'Action 0'), 'Action 0');
  const profile = { behavior: 'dsh-pet', actions };
  assert.equal(nextCompanionAction(profile), '待机呼吸休闲');
  const random = Math.random;
  try {
    Math.random = () => 0.05;
    assert.equal(nextCompanionAction(profile, '喝茶'), '待机呼吸休闲', 'original idle weight');
    Math.random = () => 0.5;
    const chosen = nextCompanionAction(profile, '喝茶');
    assert.notEqual(nextCompanionAction(profile, chosen), chosen, 'original picker excludes current in multi-action category');
    const { default: config } = await import('../display/vendor/dsh-pet/animation-config.json', { with: { type: 'json' } });
    const ambient = new Set(config.animations.categories.flatMap(c => c.actions).concat(config.animations.idle));
    Math.random = random;
    for (let i = 0; i < 1000; i++) assert(ambient.has(nextCompanionAction(profile, chosen)), 'do not shuffle event/interaction actions into ambient playback');
  } finally { Math.random = random; }
  await assert.rejects(reader.select('../pet'), /library ID/);
  const invalid = join(root, 'escape'); await mkdir(invalid);
  await symlink(join(dir, '0.gif'), join(invalid, 'outside.gif'));
  await writeFile(join(invalid, 'manifest.json'), JSON.stringify({ version: 1, id: 'escape', actions: [{ ...actions[0], file: 'outside.gif' }] }));
  await assert.rejects(reader.select('escape'), /outside/);
  await writeFile(join(dir, '0.gif'), 'changed');
  const fresh = createCompanionLibraryReader(root);
  await assert.rejects(fresh.select('pet', 'Action 0'), /verification/);
  console.log('PASS all 106 assets addressable, original weighted fixed-position selection, exclusion, event boundaries and asset verification');
} finally { await rm(root, { recursive: true, force: true }); }
