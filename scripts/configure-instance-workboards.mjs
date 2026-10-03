#!/usr/bin/env node
import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile as callback } from 'node:child_process';
import { promisify } from 'node:util';
import { writeJsonAtomic } from '../chat/fs-utils.mjs';
import { buildFeishuWorkboardService, upgradeFeishuWorkboardState } from '../connectors/feishu/workboard-runtime.mjs';

const execFile = promisify(callback);
const options = { bots: [], legacy: [], retire: [], apply: false };
const flags = { '--config-dir': 'configDir', '--project-root': 'projectRoot', '--base-url': 'baseUrl',
  '--source-freeze-path': 'sourceFreezePath', '--bot-config': 'bots', '--legacy-state': 'legacy', '--retire-service': 'retire' };
const args = process.argv.slice(2);
if (!args.length || args.includes('--help')) {
  console.log('Usage: node scripts/configure-instance-workboards.mjs --config-dir <absolute> --project-root <absolute> --base-url <instance-url> --bot-config <path> [--bot-config <path> ...] [--legacy-state <path>] [--retire-service <unit>] [--apply]\nDefaults to a read-only plan. --apply enables all registered and future members of this instance, preserving opt-outs and original card receipts. Linux user services only.');
  process.exit(0);
}
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--apply') { options.apply = true; continue; }
  const name = flags[args[i]];
  if (!name || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Invalid argument ${args[i]}`);
  const value = args[++i];
  if (Array.isArray(options[name])) options[name].push(value); else options[name] = value;
}
if (process.platform !== 'linux' || !options.configDir?.startsWith('/') || !options.projectRoot?.startsWith('/')
    || !options.baseUrl || !options.bots.length) throw new Error('Supply Linux instance paths, base URL and its active Bot configs');
const routes = new Map();
for (const path of options.bots) {
  const config = JSON.parse(await readFile(path, 'utf8'));
  const route = config.botId || 'default';
  if (!/^[a-zA-Z0-9_-]+$/.test(route) || routes.has(route) || !config.appId || !config.appSecret
      || new URL(config.chatBaseUrl).origin !== new URL(options.baseUrl).origin) throw new Error('Bot config is invalid, duplicated or belongs to another instance');
  routes.set(route, { configPath: resolve(path), statePath: join(options.configDir, 'workboards', `feishu-${route}.json`),
    unit: `remotelab-feishu-workboard-${route}.service` });
}
for (const path of options.legacy) {
  const state = JSON.parse(await readFile(path, 'utf8'));
  const route = routes.get(state.sourceRouteId);
  if (!route || route.legacyPath) throw new Error('Legacy state must match exactly one selected Bot');
  route.legacyPath = resolve(path);
}
for (const unit of options.retire) {
  if (!/^remotelab-feishu-workboard-[a-zA-Z0-9_-]+\.service$/.test(unit)
      || [...routes.values()].some(route => route.unit === unit)) throw new Error('Only an old workboard service can be retired');
}
console.log(JSON.stringify({ apply: options.apply, scope: 'this-instance-all-members',
  routes: [...routes.keys()], retire: options.retire }, null, 2));
if (!options.apply) process.exit(0);

const backup = join(options.configDir, 'workboards', 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(backup, { recursive: true, mode: 0o700 });
const policyPath = join(options.configDir, 'workboard-opt-ins.json');
let policy = {};
try { policy = JSON.parse(await readFile(policyPath, 'utf8')); await copyFile(policyPath, join(backup, 'workboard-opt-ins.json')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
// Stop the old writer before reading its last acknowledged state. Never run
// old and replacement services concurrently against the same conversation.
for (const unit of options.retire) await execFile('systemctl', ['--user', 'disable', '--now', unit]);
for (const route of routes.values()) {
  const loaded = await execFile('systemctl', ['--user', 'show', route.unit, '-p', 'LoadState', '--value']);
  if (loaded.stdout.trim() === 'loaded') await execFile('systemctl', ['--user', 'stop', route.unit]);
}
const unitDir = join(process.env.HOME, '.config', 'systemd', 'user');
await mkdir(unitDir, { recursive: true });
for (const [routeId, route] of routes) {
  let previous = {};
  try { previous = JSON.parse(await readFile(route.statePath, 'utf8')); await copyFile(route.statePath, join(backup, `feishu-${routeId}.json`)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (route.legacyPath && previous.scope !== 'instance') {
    previous = JSON.parse(await readFile(route.legacyPath, 'utf8'));
    await copyFile(route.legacyPath, join(backup, `legacy-${routeId}.json`));
  }
  const state = upgradeFeishuWorkboardState(previous, { sourceRouteId: routeId, botConfigPath: route.configPath });
  await writeJsonAtomic(route.statePath, state, { mode: 0o600 });
  const unitPath = join(unitDir, route.unit);
  try { await copyFile(unitPath, join(backup, route.unit)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeFile(unitPath, buildFeishuWorkboardService({ node: process.execPath, projectRoot: options.projectRoot,
    configDir: options.configDir, statePath: route.statePath, sourceFreezePath: options.sourceFreezePath }), { mode: 0o600 });
}
await execFile('systemctl', ['--user', 'daemon-reload']);
for (const route of routes.values()) {
  await execFile('systemctl', ['--user', 'enable', '--now', route.unit]);
  await execFile('systemctl', ['--user', 'restart', route.unit]);
  await execFile('systemctl', ['--user', 'is-active', route.unit]);
}
// Set the future-admission default last. The caller still verifies worker
// readiness, live delivery, restart recovery and actual model behaviour.
await writeJsonAtomic(policyPath, { ...policy, defaultEnabled: true }, { mode: 0o600 });
console.log(JSON.stringify({ activated: true, backup, units: [...routes.values()].map(route => route.unit) }));
