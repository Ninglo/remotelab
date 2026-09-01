import { collectCodexUsageSummary, renderCodexUsageSummary } from './codex-usage-summary.mjs';

function printHelp(stdout = process.stdout) {
  stdout.write(`Usage:\n  remotelab usage-summary [options]\n\nOptions:\n  --days <count>            Look back N days (default: 7)\n  --top <count>             Show top N directories/days/sessions (default: 10)\n  --now <timestamp>         Override the window end time (ISO timestamp)\n  --json                    Print machine-readable JSON\n  --help                    Show this help\n`);
}

function parsePositiveInteger(value, fallback, flagName) {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid value for ${flagName}: ${value || '(missing)'}`);
  }
  return parsed || fallback;
}

function parseTimestamp(value, flagName) {
  const parsed = Date.parse(value || '');
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid value for ${flagName}: ${value || '(missing)'}`);
  }
  return parsed;
}

function parseArgs(argv = []) {
  const options = {
    days: 7,
    top: 10,
    json: false,
    help: false,
    nowMs: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--days':
        options.days = parsePositiveInteger(argv[index + 1], 7, '--days');
        index += 1;
        break;
      case '--top':
        options.top = parsePositiveInteger(argv[index + 1], 10, '--top');
        index += 1;
        break;
      case '--now':
        options.nowMs = parseTimestamp(argv[index + 1], '--now');
        index += 1;
        break;
      case '--json':
        options.json = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

export async function runUsageSummaryCommand(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  const options = parseArgs(argv);

  if (options.help) {
    printHelp(stdout);
    return 0;
  }

  const summary = await collectCodexUsageSummary(options);
  if (options.json) {
    stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  }

  stdout.write(renderCodexUsageSummary(summary));
  return 0;
}
