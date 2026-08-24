import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const PI_MODEL_CACHE_TTL_MS = 30_000;
const PI_THINKING_LEVELS = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

let cachedCatalog = null;
let cachedAt = 0;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isGptFamilyModel(modelId) {
  const basename = trimString(modelId).split('/').pop()?.toLowerCase() || '';
  return /^(gpt-|codex-|o[1-9](?:-|$))/.test(basename);
}

function shouldExposeRoute(provider, modelId) {
  if (!provider || !modelId) return false;
  // GPT-family choices in Pi intentionally use the Codex subscription/login
  // path. Do not expose API-key variants of the same family as duplicate
  // product choices.
  return !isGptFamilyModel(modelId) || provider === 'openai-codex';
}

export function buildPiModelRouteId(provider, modelId) {
  const normalizedProvider = trimString(provider);
  const normalizedModel = trimString(modelId);
  if (!normalizedProvider || !normalizedModel) return '';
  return `${normalizedProvider}/${normalizedModel}`;
}

export function resolvePiModelRoute(selection) {
  const normalized = trimString(selection);
  if (!normalized) {
    return { provider: 'openai-codex', model: '' };
  }
  const separator = normalized.indexOf('/');
  if (separator > 0 && separator < normalized.length - 1) {
    return {
      provider: normalized.slice(0, separator),
      model: normalized.slice(separator + 1),
    };
  }
  // Older Pi selections stored only the Codex model id. Keeping this narrow
  // fallback avoids turning a historical session into an ambiguous provider
  // choice while all new selections use provider-qualified internal ids.
  return { provider: 'openai-codex', model: normalized };
}

export function parsePiModelList(output) {
  const models = [];
  const seen = new Set();
  for (const rawLine of String(output || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^provider\s+model\s+/i.test(line)) continue;
    const columns = line.split(/\s{2,}/).map((value) => value.trim()).filter(Boolean);
    if (columns.length < 6) continue;
    const [provider, modelId, , , thinking] = columns;
    if (!shouldExposeRoute(provider, modelId)) continue;
    const id = buildPiModelRouteId(provider, modelId);
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const reasoning = thinking === 'yes'
      ? {
        kind: 'enum',
        label: 'Thinking',
        levels: [...PI_THINKING_LEVELS],
        default: 'medium',
      }
      : { kind: 'none', label: 'Thinking' };
    models.push({
      id,
      label: modelId,
      reasoning,
      ...(reasoning.kind === 'enum'
        ? {
          defaultEffort: reasoning.default,
          effortLevels: [...reasoning.levels],
        }
        : {}),
    });
  }
  return models;
}

export async function discoverPiModels(options = {}) {
  const refresh = options.refresh === true;
  const now = Date.now();
  if (!refresh && cachedCatalog && now - cachedAt < PI_MODEL_CACHE_TTL_MS) {
    return cachedCatalog;
  }

  const command = trimString(options.command) || 'pi';
  const { stdout } = await execFileAsync(command, ['--list-models'], {
    env: options.env || process.env,
    timeout: Number.isFinite(options.timeoutMs) ? options.timeoutMs : 20_000,
    maxBuffer: 5 * 1024 * 1024,
  });
  const models = parsePiModelList(stdout);
  const preferredCodex = models.find((model) => model.id === 'openai-codex/gpt-5.6-sol')
    || models.find((model) => model.id.startsWith('openai-codex/'))
    || models[0]
    || null;
  const reasoning = preferredCodex?.reasoning || { kind: 'none', label: 'Thinking' };
  cachedCatalog = {
    models,
    effortLevels: reasoning.kind === 'enum' ? [...reasoning.levels] : null,
    defaultModel: preferredCodex?.id || null,
    reasoning,
  };
  cachedAt = now;
  return cachedCatalog;
}
