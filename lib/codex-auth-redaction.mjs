import { chmod, chown, lstat, mkdir, readFile, stat, unlink, writeFile } from 'fs/promises';
import { dirname } from 'path';

export const GUEST_CODEX_REDACTED_EMAIL = 'guest-instance@example.com';
export const GUEST_CODEX_REDACTED_NAME = 'RemoteLab Guest';
export const GUEST_CODEX_CONFIG_TOML = [
  '# Guest-scoped Codex home.',
  '# Keep this minimal and avoid inheriting owner-local feature state.',
  '',
  '[features]',
  'plugins = false',
  'apps = false',
  '',
].join('\n');

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function decodeBase64Url(segment) {
  const normalized = trimString(segment).replace(/-/g, '+').replace(/_/g, '/');
  if (!normalized) {
    throw new Error('Missing base64url segment');
  }
  const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function encodeBase64Url(text) {
  return Buffer.from(String(text || ''), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function redactIdTokenPayload(value, { email = GUEST_CODEX_REDACTED_EMAIL, name = GUEST_CODEX_REDACTED_NAME } = {}) {
  if (Array.isArray(value)) {
    return value.map((entry) => redactIdTokenPayload(entry, { email, name }));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const next = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'email' && typeof entry === 'string') {
      next[key] = email;
      continue;
    }
    if (key === 'name' && typeof entry === 'string') {
      next[key] = name;
      continue;
    }
    if (key === 'email_verified') {
      next[key] = false;
      continue;
    }
    next[key] = redactIdTokenPayload(entry, { email, name });
  }
  return next;
}

export function sanitizeGuestCodexAuthContent(content, options = {}) {
  const raw = typeof content === 'string' ? content : String(content || '');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }

  const idToken = trimString(parsed?.tokens?.id_token);
  if (!idToken) {
    return `${JSON.stringify(parsed, null, 2)}\n`;
  }

  const parts = idToken.split('.');
  if (parts.length !== 3) {
    return `${JSON.stringify(parsed, null, 2)}\n`;
  }

  let payload;
  try {
    payload = JSON.parse(decodeBase64Url(parts[1]));
  } catch {
    return `${JSON.stringify(parsed, null, 2)}\n`;
  }

  const redactedPayload = redactIdTokenPayload(payload, options);
  const next = {
    ...parsed,
    tokens: {
      ...parsed.tokens,
      id_token: `${parts[0]}.${encodeBase64Url(JSON.stringify(redactedPayload))}.${parts[2]}`,
    },
  };
  return `${JSON.stringify(next, null, 2)}\n`;
}

export async function writeGuestCodexAuthFile({ sourcePath = '', targetPath = '', content = null } = {}) {
  const normalizedTarget = trimString(targetPath);
  if (!normalizedTarget) return false;

  let rawContent = content;
  if (rawContent == null) {
    const normalizedSource = trimString(sourcePath);
    if (!normalizedSource) return false;
    try {
      rawContent = await readFile(normalizedSource, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  }

  await mkdir(dirname(normalizedTarget), { recursive: true });
  try {
    const existing = await lstat(normalizedTarget);
    if (existing.isSymbolicLink()) {
      await unlink(normalizedTarget);
    }
  } catch {
  }
  await writeFile(normalizedTarget, sanitizeGuestCodexAuthContent(rawContent), 'utf8');
  try {
    const parentStats = await stat(dirname(normalizedTarget));
    await chown(normalizedTarget, parentStats.uid, parentStats.gid);
  } catch (error) {
    if (error?.code !== 'EPERM') {
      throw error;
    }
  }
  await chmod(normalizedTarget, 0o600);
  return true;
}

export async function writeGuestCodexConfigFile(targetPath) {
  const normalizedTarget = trimString(targetPath);
  if (!normalizedTarget) return false;
  await mkdir(dirname(normalizedTarget), { recursive: true });
  try {
    const existing = await lstat(normalizedTarget);
    if (existing.isSymbolicLink()) {
      await unlink(normalizedTarget);
    }
  } catch {
  }
  await writeFile(normalizedTarget, GUEST_CODEX_CONFIG_TOML, 'utf8');
  return true;
}
