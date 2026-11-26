import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ANSI_ESCAPE_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const FIXED_EFFORT_RE = /-(low|medium|high|xhigh|max)$/i;
const NO_REASONING_CONTROL = { kind: 'none', label: 'Thinking' };

export function antigravityVariantEffort(modelId) {
  return modelId.match(FIXED_EFFORT_RE)?.[1].toLowerCase() || '';
}

export function parseAntigravityModels(output) {
  const seen = new Set();
  const families = new Map();
  for (const rawLine of String(output || '').split(/\r?\n/)) {
    const line = rawLine.replace(ANSI_ESCAPE_RE, '').trim();
    if (!line) continue;
    const match = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\t|\s{2,})(.+)$/);
    if (!match || seen.has(match[1])) continue;
    const id = match[1];
    const label = match[2].trim();
    seen.add(id);
    const suffix = antigravityVariantEffort(id);
    const labelSuffix = label.match(/\s+\(([^)]+)\)$/);
    const effort = suffix && labelSuffix?.[1].toLowerCase() === suffix ? suffix : '';
    const familyId = effort ? id.slice(0, -effort.length - 1) : id;
    const family = families.get(familyId) || [];
    family.push({ id, label, effort, familyLabel: effort ? label.slice(0, labelSuffix.index) : label });
    families.set(familyId, family);
  }

  return [...families].flatMap(([id, family]) => {
    const variants = family.filter(model => model.effort);
    if (variants.length < 2) {
      return family.map(({ id: modelId, label }) => {
        const effort = antigravityVariantEffort(modelId);
        return effort
          ? {
              id: modelId,
              label,
              defaultEffort: effort,
              effortLevels: [effort],
              reasoning: { kind: 'enum', label: 'Thinking', levels: [effort], default: effort },
            }
          : { id: modelId, label, reasoning: NO_REASONING_CONTROL };
      });
    }

    const effortVariants = Object.fromEntries(variants.map(model => [model.effort, model.id]));
    const levels = EFFORT_LEVELS.filter(effort => Object.hasOwn(effortVariants, effort));
    const defaultEffort = levels.includes('medium') ? 'medium' : variants[0].effort;
    return [{
      id,
      label: family[0].familyLabel,
      effortVariants,
      defaultEffort,
      effortLevels: levels,
      reasoning: { kind: 'enum', label: 'Thinking', levels, default: defaultEffort },
    }];
  });
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
      effortLevels: null,
      defaultModel: null,
      reasoning: NO_REASONING_CONTROL,
    };
  } catch (error) {
    return {
      models: [],
      effortLevels: null,
      defaultModel: null,
      reasoning: NO_REASONING_CONTROL,
      discoveryError: error?.message || String(error),
    };
  }
}
