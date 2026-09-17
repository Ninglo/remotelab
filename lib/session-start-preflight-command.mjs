import {
  collectSessionStartPreflightStats,
  renderSessionStartPreflightStats,
  SESSION_START_PREFLIGHT_CONFIG_FILE,
} from '../chat/session-start-preflight.mjs';

function printHelp(stdout = process.stdout) {
  stdout.write(`Usage:\n  remotelab session-preflight stats [options]\n  remotelab session-preflight status [--json]\n\nOptions:\n  --days <count>            Look back N local calendar days (default: 7)\n  --now <timestamp>         Override the window end time (ISO timestamp)\n  --json                    Print machine-readable JSON\n  --help                    Show this help\n`);
}

function positiveInteger(value, flag) {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 366) {
    throw new Error(`Invalid value for ${flag}: ${value || '(missing)'}`);
  }
  return parsed;
}

function parseArgs(argv = []) {
  const options = { action: 'stats', days: 7, now: null, json: false, help: false };
  let index = 0;
  if (argv[0] && !argv[0].startsWith('-')) {
    options.action = argv[0];
    index = 1;
  }
  if (!['stats', 'status'].includes(options.action)) {
    throw new Error(`Unknown session-preflight action: ${options.action}`);
  }
  for (; index < argv.length; index += 1) {
    switch (argv[index]) {
      case '--days':
        options.days = positiveInteger(argv[index + 1], '--days');
        index += 1;
        break;
      case '--now': {
        const parsed = Date.parse(argv[index + 1] || '');
        if (!Number.isFinite(parsed)) throw new Error(`Invalid value for --now: ${argv[index + 1] || '(missing)'}`);
        options.now = new Date(parsed);
        index += 1;
        break;
      }
      case '--json': options.json = true; break;
      case '--help':
      case '-h': options.help = true; break;
      default: throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  return options;
}

export async function runSessionStartPreflightCommand(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  const options = parseArgs(argv);
  if (options.help) {
    printHelp(stdout);
    return 0;
  }
  const summary = await collectSessionStartPreflightStats({ days: options.days, now: options.now || undefined });
  if (options.action === 'status') {
    const status = {
      configFile: SESSION_START_PREFLIGHT_CONFIG_FILE,
      enabled: summary.policy?.enabled === true,
      policy: summary.policy,
    };
    stdout.write(options.json
      ? `${JSON.stringify(status, null, 2)}\n`
      : `Session start preflight: ${status.enabled ? 'enabled' : 'disabled'}\nConfig: ${status.configFile}\n${status.policy ? `Policy: ${JSON.stringify(status.policy)}\n` : ''}`);
    return 0;
  }
  stdout.write(options.json ? `${JSON.stringify(summary, null, 2)}\n` : renderSessionStartPreflightStats(summary));
  return 0;
}
