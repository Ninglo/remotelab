import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ANSI_ESCAPE_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const DEFAULT_EFFORT_LEVELS = ['low', 'medium', 'high'];
const FIXED_EFFORT_RE = /-(low|medium|high|xhigh|max)$/i;

function modelEffort(modelId) {
  return String(modelId || '').match(FIXED_EFFORT_RE)?.[1].toLowerCase() || '';
}

export function parseAntigravityModels(output) {
  const seen = new Set();
  const models = [];
  for (const rawLine of String(output || '').split(/\r?\n/)) {
    const line = rawLine.replace(ANSI_ESCAPE_RE, '').trim();
    if (!line) continue;
    const match = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\t|\s{2,})(.+)$/);
    if (!match || seen.has(match[1])) continue;
    seen.add(match[1]);
    const fixedEffort = modelEffort(match[1]);
    const effortLevels = fixedEffort ? [fixedEffort] : [...DEFAULT_EFFORT_LEVELS];
    models.push({
      id: match[1],
      label: match[2].trim(),
      defaultEffort: fixedEffort || 'medium',
      effortLevels,
      reasoning: {
        kind: 'enum',
        label: 'Thinking',
        levels: effortLevels,
        default: fixedEffort || 'medium',
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
