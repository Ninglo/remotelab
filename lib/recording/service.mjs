import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CONFIG_DIR } from '../config.mjs';
const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../../cli.js', import.meta.url));
function xml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }
function unitArg(value) {
  if (/[\r\n\0]/.test(value)) throw Error('Invalid service path');
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') + '"';
}
export function recordingServiceSpec(root, { platform = process.platform, home = homedir(), node = process.execPath, configDir = CONFIG_DIR } = {}) {
  const key = createHash('sha256').update(root).digest('hex').slice(0, 12);
  if (platform === 'darwin') {
    const name = `dev.remotelab.recording.${key}`;
    const args = [node, cli, 'recording', 'serve', '--root', root].map((s) => `<string>${xml(s)}</string>`).join('');
    return { name, path: join(home, 'Library', 'LaunchAgents', `${name}.plist`), body: `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${name}</string><key>ProgramArguments</key><array>${args}</array><key>EnvironmentVariables</key><dict><key>REMOTELAB_CONFIG_DIR</key><string>${xml(configDir)}</string><key>PATH</key><string>${xml(process.env.PATH || '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin')}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer><key>StandardOutPath</key><string>${xml(join(root, 'service.log'))}</string><key>StandardErrorPath</key><string>${xml(join(root, 'service.log'))}</string></dict></plist>\n` };
  }
  if (platform === 'linux') {
    const name = `remotelab-recording-${key}.service`;
    const command = [node, cli, 'recording', 'serve', '--root', root].map(unitArg).join(' ');
    return { name, path: join(home, '.config', 'systemd', 'user', name), body: `[Unit]\nDescription=RemoteLab hardware recording\nAfter=default.target\n\n[Service]\nType=simple\nEnvironment=${unitArg(`REMOTELAB_CONFIG_DIR=${configDir}`)}\nEnvironment=${unitArg(`PATH=${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`)}\nExecStart=${command}\nRestart=on-failure\nRestartSec=2\nUMask=0077\n\n[Install]\nWantedBy=default.target\n` };
  }
  throw Error('Recording service supports macOS and Linux');
}
export async function installRecordingService(root, { apply = false } = {}) {
  const spec = recordingServiceSpec(root);
  if (!apply) return { ...spec, applied: false };
  await mkdir(dirname(spec.path), { recursive: true });
  await writeFile(spec.path, spec.body, { mode: 0o600 });
  if (process.platform === 'darwin') {
    const domain = `gui/${process.getuid()}`;
    try { await exec('launchctl', ['bootout', `${domain}/${spec.name}`]); } catch {}
    await exec('launchctl', ['bootstrap', domain, spec.path]);
  } else {
    await exec('systemctl', ['--user', 'daemon-reload']);
    await exec('systemctl', ['--user', 'enable', '--now', spec.name]);
  }
  return { name: spec.name, path: spec.path, applied: true };
}
export async function uninstallRecordingService(root, { apply = false } = {}) {
  const spec = recordingServiceSpec(root);
  if (!apply) return { name: spec.name, path: spec.path, applied: false };
  if (process.platform === 'darwin') {
    try { await exec('launchctl', ['bootout', `gui/${process.getuid()}/${spec.name}`]); }
    catch (error) { if (!/Could not find service|No such process/i.test(error.stderr || '')) throw error; }
  } else {
    await exec('systemctl', ['--user', 'disable', '--now', spec.name]);
  }
  await rm(spec.path, { force: true });
  if (process.platform === 'linux') await exec('systemctl', ['--user', 'daemon-reload']);
  return { name: spec.name, path: spec.path, applied: true, recordingsPreserved: true };
}
