import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_DIR } from './config.mjs';

export async function loadEmployeeSiteSettings(configDir = CONFIG_DIR) {
  try { return JSON.parse(await readFile(join(configDir, 'site-login.json'), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return JSON.parse(await readFile(join(configDir, 'qianyan-internal.json'), 'utf8'));
  }
}

export async function siteLoginConfigured(configDir = CONFIG_DIR) {
  try {
    const cfg = await loadEmployeeSiteSettings(configDir);
    if (!(cfg.realm && cfg.tenantKey && cfg.feishuConfigPath)) throw new Error('Incomplete employee login configuration');
    return true;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// Attribution follows the accepted input, never the Session creator or OS user.
export async function resolveSiteCreator(explicitPersonId) {
  const { loadAuthDocument } = await import('./auth-config.mjs');
  const { people } = await loadAuthDocument({ persistMigration: false });
  let personId = explicitPersonId;
  if (!personId && process.env.REMOTELAB_SESSION_ID && process.env.REMOTELAB_REQUEST_ID) {
    const { requests } = await import('../chat/requests.mjs');
    const request = await requests.byRequest(process.env.REMOTELAB_SESSION_ID, process.env.REMOTELAB_REQUEST_ID);
    const identityId = request?.options?.initiatedByIdentityId;
    personId = request?.options?.viewPersonId
      || people.find(p => p.identities?.some(i => i.id === identityId))?.id;
  }
  if (!personId) return null;
  if (!people.some(p => p.id === personId)) throw new Error('Site owner must be an existing verified Person');
  return personId;
}

export async function resolveSitePolicy({ access, ownerPersonId, existing, configDir, legacyAccess = 'public' } = {}) {
  const configured = await siteLoginConfigured(configDir);
  const selected = access || (existing ? existing.access || legacyAccess : configured ? 'employee' : legacyAccess);
  if (!['employee', 'public', 'basic'].includes(selected)) throw new Error('Invalid site access mode');
  if (selected === 'employee') {
    if (!configured) throw new Error('Configure employee site login before publishing an internal site');
    if ((await loadEmployeeSiteSettings(configDir)).enabled === false) throw new Error('Employee site login is disabled');
  }
  const owner = existing?.ownerPersonId || await resolveSiteCreator(ownerPersonId);
  if (selected === 'employee' && !owner) throw new Error('Cannot identify site creator; supply --owner <verified-person-id> outside a human Request');
  return { access: selected, ownerPersonId: owner, adminPersonIds: existing?.adminPersonIds || [] };
}
