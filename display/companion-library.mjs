import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { pick, rollKind, pickCategoryAction } from './vendor/dsh-pet/pickers.mjs';
import defaults from './vendor/dsh-pet/animation-config.json' with { type: 'json' };

// Same fixed-position, left-facing chain as upstream playIdle(). Called only
// after the player reports ended; clock/text refreshes reuse the current name.
export function nextCompanionAction(library, current) {
  if (library.behavior !== 'dsh-pet') return pick(library.actions.map(a => a.name), current);
  const { animations: a, animationWeights: w } = defaults;
  if (!current) return a.idle[0];
  return rollKind(Math.random(), w, { fixed: true }) === 'idle'
    ? pick(a.idle, current)
    : pickCategoryAction(a.categories, a.idle, 'left', current).name;
}

// Libraries are installed by the operator, never uploaded as paths by a device.
export function createCompanionLibraryReader(root) {
  const manifests = new Map();
  const assets = new Map();
  async function contained(base, relative) {
    if (typeof relative !== 'string' || !relative || relative.includes('\\')) throw Error('Invalid library path');
    const directory = await realpath(base);
    const file = await realpath(resolve(directory, relative));
    if (!file.startsWith(directory + sep)) throw Error('Library asset is outside its directory');
    return file;
  }
  async function manifest(id) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id || '')) throw Error('Invalid companion library ID');
    const directory = await contained(root, id);
    const filename = await contained(directory, 'manifest.json');
    const info = await stat(filename);
    const version = `${info.ino}:${info.size}:${info.mtimeMs}`;
    if (manifests.get(id)?.version === version) return manifests.get(id).value;
    const value = JSON.parse(await readFile(filename, 'utf8'));
    if (value.version !== 1 || value.id !== id || !Array.isArray(value.actions) || !value.actions.length) throw Error('Invalid companion library manifest');
    const ids = new Set();
    for (const action of value.actions) {
      if (!/^[a-f0-9]{64}$/.test(action.sha256 || '') || typeof action.name !== 'string' || !action.name.trim()
          || typeof action.file !== 'string' || ids.has(action.sha256)) throw Error('Invalid or duplicate companion action');
      if (!Number.isInteger(action.frames) || action.frames < 1 || action.frames > 128
          || !Number.isFinite(action.durationMs) || action.durationMs < 100 || action.durationMs > 12800) throw Error('Companion action exceeds installed player limits');
      ids.add(action.sha256);
    }
    const loaded = { ...value, directory };
    manifests.set(id, { version, value: loaded });
    return loaded;
  }
  return { manifest,
    async next(id, current) { return nextCompanionAction(await manifest(id), current); },
    async select(id, name) {
    const library = await manifest(id);
    const count = library.actions.length;
    const selectedName = name || nextCompanionAction(library);
    const action = library.actions.find(a => a.name === selectedName);
    if (!action) throw Error(`Companion action is not installed: ${selectedName}`);
    let gifBase64 = assets.get(action.sha256);
    if (!gifBase64) {
      const filename = await contained(library.directory, action.file);
      const bytes = await readFile(filename);
      if (bytes.length > 3 * 1024 * 1024 || !/^GIF8[79]a/.test(bytes.toString('ascii', 0, 6))
          || createHash('sha256').update(bytes).digest('hex') !== action.sha256) throw Error('Companion library asset failed verification');
      gifBase64 = bytes.toString('base64');
      assets.set(action.sha256, gifBase64);
      while (assets.size > 4) assets.delete(assets.keys().next().value);
    }
    return { action: { name: action.name, gifBase64 }, total: count, category: action.category || '日常',
      durationMs: action.durationMs, frames: action.frames, libraryId: id };
  } };
}
