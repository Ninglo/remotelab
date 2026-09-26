import { appendFile, chmod, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const themes = new Set(['classic', 'paper', 'mist', 'midnight', 'rose', 'sky', 'sun', 'mint']);

export function validDisplayTheme(theme) {
  return typeof theme === 'string' && themes.has(theme);
}

export async function recordDisplayTheme({ personId, theme, action, configDir = process.env.REMOTELAB_CONFIG_DIR || join(homedir(), '.config', 'remotelab') }) {
  if (!personId || !validDisplayTheme(theme) || !['selected', 'applied'].includes(action)) return false;
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const file = join(configDir, 'display-theme-events.jsonl');
  const personHash = createHash('sha256').update(`display-theme:${personId}`).digest('hex');
  await appendFile(file, `${JSON.stringify({ version: 1, ts: new Date().toISOString(), action, theme, personHash })}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  return true;
}

export function appliedThemeFromPayload(raw) {
  try {
    const payload = JSON.parse(raw);
    return payload?.version === 21 && validDisplayTheme(payload?.state?.theme) ? payload.state.theme : null;
  } catch { return null; }
}
