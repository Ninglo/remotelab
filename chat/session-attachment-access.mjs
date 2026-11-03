import { join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { CHAT_IMAGES_DIR } from '../lib/config.mjs';
import { canAccessSession, isSessionAdministrator } from './session-access.mjs';

const valid = name => /^[a-zA-Z0-9_-]+\.[a-z0-9]+$/.test(name || '');
const directory = join(CHAT_IMAGES_DIR, '.session-access');
export async function registerAttachmentSession(filename, sessionId) {
  if (!valid(filename) || !sessionId) return;
  await mkdir(directory, { recursive: true });
  try { await writeFile(join(directory, filename + '.json'), JSON.stringify({ sessionId }), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}

// Historical attachments are indexed only from trusted stored events as they
// are read. Never accept a browser's filename/session claim as ownership proof.
export async function registerEventAttachments(sessionId, events) {
  for (const event of events || []) {
    for (const attachment of [...(event.images || []), ...(event.attachments || [])]) {
      if (!attachment.assetId) await registerAttachmentSession(attachment.filename, sessionId);
    }
  }
}

export async function requireAttachmentAccess(actor, filename) {
  if (valid(filename) && isSessionAdministrator(actor)) return;
  if (valid(filename)) {
    let entry;
    try { entry = JSON.parse(await readFile(join(directory, filename + '.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (entry && await canAccessSession(actor, entry.sessionId)) return;
  }
  throw Object.assign(new Error('Attachment access denied'), { statusCode: 403 });
}
