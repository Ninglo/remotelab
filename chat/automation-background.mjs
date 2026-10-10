import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CONFIG_DIR } from '../lib/config.mjs';
import { normalizeAutomationPurpose } from '../lib/automation-purpose.mjs';

const run = promisify(execFile);
// Descriptors are navigation metadata. Runtime truth remains at each original source.
export async function listAutomationBackground({ path = join(CONFIG_DIR, 'automation-background.json'),
  load = readFile, execute = run, env = process.env } = {}) {
  let config;
  try { config = JSON.parse(await load(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; return [{ id: 'background-source-error', title: 'Background source unavailable', state: 'unknown' }]; }
  return Promise.all((config.mechanisms || []).map(async item => {
    const entry = { id: item.id, title: item.title, purpose: normalizeAutomationPurpose(item.purpose),
      trigger: item.trigger || '', note: item.note || '', state: 'unknown', checkedAt: new Date().toISOString() };
    try {
      const source = item.source || {};
      if (source.kind === 'systemd' && /^[A-Za-z0-9@_.:-]+\.(service|timer)$/.test(source.unit || '')) {
        const { stdout } = await execute('systemctl', ['show', source.unit, '--property=LoadState,ActiveState,SubState,Result'], { timeout: 5000 });
        const values = Object.fromEntries(stdout.trim().split('\n').map(line => line.split('=')));
        entry.state = values.LoadState === 'not-found' ? 'unknown' : values.ActiveState === 'active' ? 'running'
          : values.ActiveState === 'failed' || (values.Result && values.Result !== 'success') ? 'failed' : 'inactive';
      } else if (source.kind === 'environment') {
        const value = env[source.key];
        const enabled = value === undefined ? Boolean(source.defaultEnabled) : !['0', 'false', 'off'].includes(value.toLowerCase());
        entry.state = (source.invert ? !enabled : enabled) ? 'configured' : 'disabled';
      } else if (source.kind === 'json_flag') {
        const data = JSON.parse(await load(source.path, 'utf8'));
        entry.state = data[source.key] === true ? 'configured' : data[source.key] === false ? 'disabled' : 'unknown';
      } else if (source.kind === 'sqlite_scheduler') {
        const { stdout } = await execute('python3', ['-c',
          "import sqlite3,sys; c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); r=c.execute(\"select value from app_settings where key='scheduler_enabled'\").fetchone(); print(r[0] if r else 'unknown')",
          source.path], { timeout: 5000 });
        entry.state = stdout.trim() === '1' ? 'configured' : stdout.trim() === '0' ? 'disabled' : 'unknown';
      } else if (source.kind === 'embedded') entry.state = 'configured';
    } catch { entry.state = 'unknown'; }
    return entry;
  }));
}
