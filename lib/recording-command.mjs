import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { readRecordingConfig, saveRecordingConfig, recordingRoot } from './recording/config.mjs';
import { startRecordingDaemon, controlRecording } from './recording/daemon.mjs';
import { discoverRecordingDevices, inputCommand, recordingDoctor } from './recording/platform.mjs';
import { listRecords, recordingSummary } from './recording/store.mjs';
import { installRecordingService, uninstallRecordingService } from './recording/service.mjs';

const HELP = `Usage: remotelab recording <command> [options]

Commands:
  doctor                    Check software/configuration; does not record or inspect hardware
  devices                   List audio inputs and keypads (explicit hardware discovery)
  learn-input --device ID    Print key-down events from this keypad for one-time binding
  configure --file PATH     Save a validated per-instance receiver/channel/keypad config
  enable                    Enable the configured lanes (does not start recording)
  disable                   Disable new recording; refuses while this service is running
  install [--apply]         Preview or install a user launchd/systemd recording service
  uninstall [--apply]       Stop/remove that service; preserve all saved recordings
  serve                     Run the optional hardware recorder in the foreground
  status                    Show active recordings and saved submission state
  start --lane ID           Start only this receiver channel
  stop --lane ID            Save only this receiver channel; other lanes continue
  toggle --lane ID          Toggle only this receiver channel
  retry --recording ID      Retry a saved recording without duplicating its AI request

Options:
  --root PATH               Instance-local recording state (default: config dir/recording)
  --json                    Machine-readable output (default)
  --help                    Show this help

Guide: docs/platform-skills/hardware-recording.md
Supported hosts: macOS and Linux. FFmpeg, device permissions and explicit bindings are required.
`;
export async function runRecordingCommand(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  const command = argv[0] || 'help';
  const options = {};
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (['--root', '--file', '--lane', '--device', '--recording'].includes(arg)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw Error(`Missing value for ${arg}`);
      options[arg.slice(2)] = argv[++i];
    } else if (['--apply', '--json', '--help'].includes(arg)) options[arg.slice(2)] = true;
    else throw Error(`Unknown argument: ${arg}`);
  }
  if (['help', '--help', '-h'].includes(command) || options.help) { stdout.write(HELP); return 0; }
  const root = recordingRoot(options.root);
  const config = await readRecordingConfig(root);
  const emit = (result) => stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (command === 'doctor') { emit(await recordingDoctor(config)); return 0; }
  if (command === 'devices') { emit(await discoverRecordingDevices(root, config)); return 0; }
  if (command === 'configure') {
    if (!options.file) throw Error('--file is required');
    try { await controlRecording(root, 'status'); throw Error('Stop the recording service before changing hardware bindings'); }
    catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
    const input = JSON.parse(await readFile(options.file, 'utf8'));
    const saved = await saveRecordingConfig(root, { ...input, machineId: config.machineId });
    emit({ configured: true, enabled: saved.enabled, root, lanes: saved.lanes }); return 0;
  }
  if (['enable', 'disable'].includes(command)) {
    if (command === 'disable') {
      try { await controlRecording(root, 'status'); throw Error('Stop the recording service before disabling it'); }
      catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
    }
    if (command === 'enable' && !config.lanes.length) throw Error('Bind receiver channels first');
    await saveRecordingConfig(root, { ...config, enabled: command === 'enable' }); emit({ enabled: command === 'enable', root }); return 0;
  }
  if (command === 'install') {
    if (options.apply && !config.enabled) throw Error('Enable configured recording before installing the service');
    emit(await installRecordingService(root, { apply: options.apply })); return 0;
  }
  if (command === 'uninstall') { emit(await uninstallRecordingService(root, { apply: options.apply })); return 0; }
  if (command === 'status') {
    try { emit({ running: true, ...(await controlRecording(root, 'status')) }); }
    catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
      let previous = null;
      try { previous = JSON.parse(await readFile(join(root, 'status.json'), 'utf8')); } catch {}
      emit({ running: false, enabled: config.enabled, records: (await listRecords(root)).map(recordingSummary), previous });
    }
    return 0;
  }
  if (['start', 'stop', 'toggle', 'retry'].includes(command)) {
    const id = command === 'retry' ? options.recording : options.lane;
    if (!id) throw Error(command === 'retry' ? '--recording is required' : '--lane is required');
    emit(await controlRecording(root, command, id)); return 0;
  }
  if (command === 'learn-input') {
    if (!options.device) throw Error('--device is required');
    const spec = await inputCommand(root, [{ deviceId: options.device }]);
    const child = spawn(spec.command, spec.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(stdout); child.stderr.pipe(io.stderr || process.stderr);
    process.once('SIGINT', () => child.kill());
    return await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code) => resolve(code || 0)); });
  }
  if (command === 'serve') {
    const daemon = await startRecordingDaemon({ root, config });
    emit({ running: true, root });
    await new Promise((resolve) => {
      const done = () => daemon.stop().then(resolve).catch((e) => { process.exitCode = 1; (io.stderr || process.stderr).write(e.message + '\n'); resolve(); });
      process.once('SIGINT', done); process.once('SIGTERM', done);
    });
    return 0;
  }
  throw Error(`Unknown recording command: ${command}`);
}
