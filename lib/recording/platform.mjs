import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, stat, rename, writeFile } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const project = fileURLToPath(new URL('../../', import.meta.url));

export async function buildMacInputHelper(root) {
  const target = join(root, 'bin', 'recording-input');
  const source = join(project, 'scripts/recording-input-macos.swift');
  const hash = createHash('sha256').update(await readFile(source)).digest('hex');
  try { if ((await readFile(`${target}.sha256`, 'utf8')) === hash && ((await stat(target)).mode & 0o111)) return target; } catch {}
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}`;
  await exec('xcrun', ['swiftc', source, '-o', temporary], { timeout: 120000 });
  await rename(temporary, target);
  await writeFile(`${target}.sha256`, hash, { mode: 0o600 });
  return target;
}
export async function inputCommand(root, bindings, platform = process.platform) {
  const deviceIds = [...new Set(bindings.map((b) => b.deviceId))];
  if (platform === 'darwin') return { command: await buildMacInputHelper(root), args: ['listen', ...deviceIds] };
  if (platform === 'linux') return { command: 'python3', args: [join(project, 'scripts/recording-input-linux.py'), 'listen', ...deviceIds] };
  throw Error('Hardware recording currently supports macOS and Linux hosts');
}
export async function discoverRecordingDevices(root, config, platform = process.platform) {
  if (platform === 'darwin') {
    const helper = await buildMacInputHelper(root);
    const keyboards = JSON.parse((await exec(helper, ['list'], { timeout: 10000 })).stdout);
    let audioRaw = '';
    try { const result = await exec(config.ffmpeg, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], { timeout: 10000 }); audioRaw = result.stderr; }
    catch (error) { if (error.code === 'ENOENT') throw error; audioRaw = error.stderr || ''; }
    return { keyboards, audioRaw, binding: 'Use uid: or serial: from the audio list, and deviceId/key from learn-input.' };
  }
  if (platform === 'linux') {
    const keyboards = JSON.parse((await exec('python3', [join(project, 'scripts/recording-input-linux.py'), 'list'], { timeout: 10000 })).stdout);
    let alsa = '', pulse = [];
    try { alsa = await readFile('/proc/asound/cards', 'utf8'); } catch {}
    try { pulse = JSON.parse((await exec('pactl', ['-f', 'json', 'list', 'sources'], { timeout: 10000 })).stdout); } catch {}
    return { keyboards, alsa, pulse, binding: 'Use a named ALSA card or PulseAudio source, not default or a changing numeric card index.' };
  }
  throw Error('Hardware recording currently supports macOS and Linux hosts');
}
export async function recordingDoctor(config, platform = process.platform) {
  const problems = [];
  if (!fs.statfs) problems.push('Hardware recording requires Node.js 18.15 or newer');
  if (!['darwin', 'linux'].includes(platform)) problems.push('Only macOS and Linux hosts are supported');
  try { await exec(config.ffmpeg, ['-version'], { timeout: 5000 }); } catch { problems.push('FFmpeg is not installed or executable'); }
  if (platform === 'darwin') {
    try {
      const { stdout, stderr } = await exec(config.ffmpeg, ['-hide_banner', '-h', 'demuxer=avfoundation'], { timeout: 5000 });
      if (!`${stdout}${stderr}`.includes('audio_device_id')) problems.push('Install an FFmpeg build with AVFoundation audio_device_id support; do not bind identical receivers by numeric index');
      await exec('xcrun', ['--find', 'swiftc'], { timeout: 5000 });
    } catch { problems.push('FFmpeg AVFoundation support and Xcode Command Line Tools are required'); }
  }
  if (platform === 'linux') {
    try { await exec('python3', ['--version'], { timeout: 5000 }); } catch { problems.push('Python 3 is required for device-specific keypad input'); }
  }
  if (!config.lanes.length) problems.push('No receiver channels are bound');
  if (!config.bindings.length) problems.push('No keypad buttons are bound; CLI start/stop remains available');
  return { supported: ['darwin', 'linux'].includes(platform), configured: !!config.lanes.length, enabled: config.enabled, ready: problems.length === 0, problems, physicalAcceptance: 'not_performed' };
}
export function keepAwake() {
  if (process.platform !== 'darwin') return null;
  const child = spawn('caffeinate', ['-i'], { stdio: 'ignore' });
  child.on('error', () => {});
  return child;
}
