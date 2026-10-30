import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CONFIG_DIR } from './config.mjs';

// Private per-person capabilities, never directory metadata or analytics data.
// The original upstream continues to validate its own credential on every use.
export function createLegacySiteLogin({ configDir = CONFIG_DIR } = {}) {
  const path = join(configDir, 'site-legacy-logins.json');
  let queue = Promise.resolve();
  const key = (site, person, port) => createHash('sha256').update(JSON.stringify([site, person, port])).digest('hex');
  async function document() {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { version: 1, entries: {} }; throw error; }
  }
  async function lookup(site, person, port) {
    if (!site || !person || !Number.isInteger(port)) return '';
    const entry = (await document()).entries[key(site, person, port)];
    return entry?.site === site && entry.person === person && entry.port === port ? entry.authorization : '';
  }
  function remember(site, person, authorization, port) {
    if (!site || !person || typeof authorization !== 'string' || !/^Basic [A-Za-z0-9+/]+=*$/.test(authorization)
      || authorization.length > 4096 || !Number.isInteger(port)) return Promise.resolve(false);
    const task = queue.then(async () => {
      const d = await document(), id = key(site, person, port);
      if (d.entries[id]?.authorization === authorization) return true;
      d.entries[id] = { site, person, port, authorization, verifiedAt: new Date().toISOString() };
      await mkdir(configDir, { recursive: true });
      const tmp = path + '.' + randomUUID();
      await writeFile(tmp, JSON.stringify(d), { mode: 0o600 }); await rename(tmp, path);
      return true;
    });
    queue = task.catch(() => {});
    return task;
  }
  return { lookup, remember, flush: () => queue };
}
export const legacySiteLogin = createLegacySiteLogin();

export async function previewIdentityPolicy(slug, port, configDir = CONFIG_DIR) {
  try {
    const d = JSON.parse(await readFile(join(configDir, 'site-identity-policies.json'), 'utf8'));
    return d.routes?.[slug]?.port === port ? d.routes[slug] : {};
  } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

export async function setPreviewIdentityPolicy(slug, port, flag, configDir = CONFIG_DIR) {
  const path = join(configDir, 'site-identity-policies.json');
  let d;
  try { d = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; d = { version: 1, routes: {} }; }
  const prior = d.routes[slug];
  d.routes[slug] = { ...(prior?.port === port ? prior : {}), port, [flag]: true };
  const tmp = path + '.' + randomUUID();
  await mkdir(configDir, { recursive: true });
  await writeFile(tmp, JSON.stringify(d, null, 2) + '\n', { mode: 0o600 }); await rename(tmp, path);
}
