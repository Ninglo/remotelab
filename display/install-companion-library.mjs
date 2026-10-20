import { copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { decodeGifFrames } from './gif-frames.mjs';

// Install reviewed assets privately beside a personal studio. No public upload,
// model generation, source mutation, pairing change, or automatic activation.
export async function installCompanionLibrary({ sourceManifest, root, id }) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id || '')) throw Error('Invalid library ID');
  const source = await realpath(dirname(resolve(sourceManifest)));
  const input = JSON.parse(await readFile(sourceManifest, 'utf8'));
  const entries = input.assets || input.actions;
  if (!Array.isArray(entries) || !entries.length) throw Error('Empty library');
  const target = join(resolve(root), id);
  try { await stat(target); throw Error('Library already exists; use a new version ID'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(join(resolve(root), '.install-'));
  const actions = [];
  try {
    await mkdir(join(stage, 'assets'), { mode: 0o700 });
    for (const entry of entries) {
      const path = await realpath(resolve(source, entry.file));
      if (!path.startsWith(source + sep)) throw Error('Source asset is outside the library');
      const bytes = await readFile(path);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (sha256 !== entry.sha256) throw Error(`Asset hash mismatch: ${entry.name}`);
      const decoded = decodeGifFrames(bytes);
      if (decoded.frames.length !== entry.frames || decoded.durationMs !== entry.durationMs
          || decoded.durationMs > 12800) throw Error(`Action timing mismatch: ${entry.name}`);
      const file = `assets/${sha256}.gif`;
      await copyFile(path, join(stage, file));
      actions.push({ name: entry.name, category: entry.category || '日常', file, sha256,
        frames: entry.frames, durationMs: entry.durationMs, width: decoded.width, height: decoded.height });
    }
    const manifest = { version: 1, id, installedAt: new Date().toISOString(), actions,
      ...(input.behavior === 'dsh-pet' ? { behavior: 'dsh-pet' } : {}) };
    await writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    await rename(stage, target);
    return { id, count: actions.length, target, bytes: entries.reduce((n, a) => n + (a.bytes || 0), 0) };
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [sourceManifest, root, id] = process.argv.slice(2);
  try {
    if (!sourceManifest || !root || !id) throw Error('Usage: node display/install-companion-library.mjs MANIFEST PRIVATE_LIBRARY_ROOT LIBRARY_ID');
    console.log(JSON.stringify(await installCompanionLibrary({ sourceManifest, root, id })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
