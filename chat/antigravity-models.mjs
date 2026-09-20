import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ANSI_ESCAPE_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const DEFAULT_EFFORT_LEVELS = ['low', 'medium', 'high'];

export function parseAntigravityModels(output) {
  const seen = new Set();
  const models = [];
  for (const rawLine of String(output || '').split(/\r?\n/)) {
    const line = rawLine.replace(ANSI_ESCAPE_RE, '').trim();
    if (!line) continue;
    const match = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s{2,}(.+)$/);
    if (!match || seen.has(match[1])) continue;
    seen.add(match[1]);
    models.push({
      id: match[1],
      label: match[2].trim(),
      defaultEffort: 'medium',
      effortLevels: [...DEFAULT_EFFORT_LEVELS],
      reasoning: {
        kind: 'enum',
        label: 'Thinking',
        levels: [...DEFAULT_EFFORT_LEVELS],
        default: 'medium',
      },
    });
  }
  return models;
}

export async function discoverAntigravityModels({ command = 'agy', env = process.env } = {}) {
  try {
    const { stdout } = await execFileAsync(command, ['models'], {
      env,
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    const models = parseAntigravityModels(stdout);
    return {
      models,
      effortLevels: [...DEFAULT_EFFORT_LEVELS],
      defaultModel: null,
      reasoning: {
        kind: 'enum',
        label: 'Thinking',
        levels: [...DEFAULT_EFFORT_LEVELS],
        default: 'medium',
      },
    };
  } catch (error) {
    return {
      models: [],
      effortLevels: [...DEFAULT_EFFORT_LEVELS],
      defaultModel: null,
      reasoning: {
        kind: 'enum',
        label: 'Thinking',
        levels: [...DEFAULT_EFFORT_LEVELS],
        default: 'medium',
      },
      discoveryError: error?.message || String(error),
    };
  }
}
