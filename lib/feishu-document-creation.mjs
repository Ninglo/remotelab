import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { CONFIG_DIR } from './config.mjs';
import { claimOnce, readRecord } from './durable-records.mjs';

export const createdDocumentPath = (appId, token, configDir = CONFIG_DIR) => join(configDir,
  'feishu-created-documents', createHash('sha256').update(`${appId}:${token}`).digest('hex') + '.json');

// Only successful creation responses are evidence of authorship. Reads, edits,
// permissions and owner transfers must never enroll somebody else's document.
export function isDocumentCreationCommand(args) {
  if (args.includes('--dry-run')) return false;
  let start = 0;
  while (args[start]?.startsWith('--')) {
    const option = args[start++];
    if (['--profile', '--as', '--format', '--config'].includes(option)) start++;
    else if (!option.includes('=') && !['--json', '--quiet', '--verbose'].includes(option)) return false;
  }
  const command = args.slice(start, start + 4);
  const matches = prefix => prefix.every((value, i) => command[i] === value);
  if (!matches(['docs', '+create']) && !matches(['docx', 'documents', 'create'])
      && !matches(['drive', 'files', 'copy']) && !matches(['wiki', 'spaces-nodes', 'create'])
      && !matches(['wiki', 'spaces', 'nodes', 'create'])
      && !(matches(['api', 'POST']) && /^\/open-apis\/(?:docx\/v1\/documents|wiki\/v2\/spaces\/[^/]+\/nodes)$/.test(command[2]))) return false;
  return true;
}

export function createdDocumentFromResult(args, result) {
  if (result?.ok !== true || result.identity !== 'bot' || !isDocumentCreationCommand(args)) return null;
  const data = result.data || {};
  const doc = data.document || data.file || data.node || data;
  if (doc.node_type === 'shortcut') return null;
  const token = doc.document_id || (doc.obj_type === 'docx' ? doc.obj_token : '')
    || (doc.type === 'docx' ? doc.token : '');
  if (!/^[a-zA-Z0-9_-]+$/.test(token || '')) return null;
  return { fileToken: token, fileType: 'docx', documentUrl: doc.url || '', title: doc.title || doc.name || '' };
}

export async function recordCreatedDocument(document, { appId, sessionId = '', configDir = CONFIG_DIR } = {}) {
  if (!appId || !document?.fileToken) throw new Error('Created document and Bot application are required');
  const record = { version: 1, ...document, appId, sessionId,
    createdAt: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString() };
  const path = createdDocumentPath(appId, document.fileToken, configDir);
  await claimOnce(path, record);
  return readRecord(path);
}

export function readCreatedDocument(appId, token, configDir = CONFIG_DIR) {
  return readRecord(createdDocumentPath(appId, token, configDir));
}
