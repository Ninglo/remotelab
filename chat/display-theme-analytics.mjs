import { appendFile, chmod, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { observeSettingRows, settingRows } from './usage-settings.mjs';

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
  if (resolve(configDir) === resolve(CONFIG_DIR)) {
    await observeSettingRows(settingRows({ 'display.theme': theme }, { scope: 'display', scopeId: personId,
      subjectPersonId: personId, stage: action === 'selected' ? 'preview' : 'applied' }),
    { personId, surface: 'web', operation: action === 'applied' ? 'change' : 'preview' });
  }
  return true;
}

export function appliedThemeFromPayload(raw) {
  try {
    const payload = JSON.parse(raw);
    return payload?.version === 21 && validDisplayTheme(payload?.state?.theme) ? payload.state.theme : null;
  } catch { return null; }
}

export async function readDisplayThemeBaseline(people, configDir = CONFIG_DIR) {
  const known = new Map(people.map(person => [createHash('sha256').update(`display-theme:${person.id}`).digest('hex'), person.id]));
  const latest = new Map(), stream = createReadStream(join(configDir, 'display-theme-events.jsonl'), { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let scanned = 0, incomplete = false;
  try {
    for await (const line of lines) {
      if (++scanned > 200_000) { incomplete = true; break; }
      if (line.length > 4096) { incomplete = true; continue; }
      let event; try { event = JSON.parse(line); } catch { incomplete = true; continue; }
      const personId = known.get(event.personHash), time = Date.parse(event.ts);
      if (!personId || event.version !== 1 || !validDisplayTheme(event.theme)
          || !['selected', 'applied'].includes(event.action) || !Number.isFinite(time)) continue;
      const key = personId + ':' + event.action;
      if ((latest.get(key)?.time || 0) <= time) latest.set(key, { personId, theme: event.theme, action: event.action, time });
    }
  } catch (error) { incomplete ||= error.code !== 'ENOENT'; }
  finally { lines.close(); stream.destroy(); }
  const rows = [...latest.values()].flatMap(event => settingRows({ 'display.theme': event.theme }, {
    scope: 'display', scopeId: event.personId, subjectPersonId: event.personId,
    stage: event.action === 'selected' ? 'preview' : 'applied',
  }).map(row => ({ ...row, observedAt: event.time })));
  return { rows, incomplete };
}
