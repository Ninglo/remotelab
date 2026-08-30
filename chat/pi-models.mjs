import { execFile, spawn } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const PI_MODEL_CACHE_TTL_MS = 30_000;
const PI_THINKING_LEVELS = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const PI_PROVIDER_LABELS = Object.freeze({
  'openai-codex': 'OpenAI',
  anthropic: 'Anthropic',
  deepseek: 'DeepSeek',
  'glm-api': 'GLM',
  'kimi-coding': 'Kimi Code',
  moonshotai: 'Kimi',
  'moonshotai-cn': 'Kimi CN',
  zai: 'Z.AI',
  'zai-coding-cn': 'GLM Coding',
});

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

export function getPiProviderLabel(provider) {
  const normalized = trimString(provider);
  if (!normalized) return '';
  if (PI_PROVIDER_LABELS[normalized]) return PI_PROVIDER_LABELS[normalized];
  return normalized
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function getSupportedPiThinkingLevels(model) {
  if (model?.reasoning !== true) return ['off'];
  const levelMap = model?.thinkingLevelMap && typeof model.thinkingLevelMap === 'object'
    ? model.thinkingLevelMap
    : null;
  return PI_THINKING_LEVELS.filter((level) => {
    const mapped = levelMap?.[level];
    if (mapped === null) return false;
    if (level === 'xhigh' || level === 'max') return mapped !== undefined;
    return true;
  });
}

function buildPiReasoning(model) {
  const levels = getSupportedPiThinkingLevels(model);
  if (model?.reasoning !== true || levels.length === 1 && levels[0] === 'off') {
    return { kind: 'none', label: 'Thinking' };
  }

  const levelMap = model?.thinkingLevelMap && typeof model.thinkingLevelMap === 'object'
    ? model.thinkingLevelMap
    : null;
  const hasExplicitEffortMap = levels.some((level) => (
    level !== 'off' && levelMap?.[level] !== undefined && levelMap[level] !== null
  ));
  const supportsGranularEffort = model?.compat?.supportsReasoningEffort === true
    || hasExplicitEffortMap;

  if (!supportsGranularEffort) {
    if (!levels.includes('off')) {
      // The model always reasons and exposes no meaningful effort choice.
      return { kind: 'none', label: 'Thinking' };
    }
    const enabledLevel = levels.includes('medium')
      ? 'medium'
      : levels.find((level) => level !== 'off');
    if (!enabledLevel) return { kind: 'none', label: 'Thinking' };
    return {
      kind: 'enum',
      label: 'Thinking',
      levels: ['off', enabledLevel],
      default: enabledLevel,
      control: 'binary',
    };
  }

  const defaultLevel = levels.includes('medium')
    ? 'medium'
    : levels.find((level) => level !== 'off') || levels[0];
  return {
    kind: 'enum',
    label: 'Thinking',
    levels,
    default: defaultLevel,
  };
}

function buildPiModelRecord(model) {
  const provider = trimString(model?.provider);
  const modelId = trimString(model?.id);
  if (!shouldExposeRoute(provider, modelId)) return null;
  const id = buildPiModelRouteId(provider, modelId);
  if (!id) return null;
  const reasoning = buildPiReasoning(model);
  return {
    id,
    label: modelId,
    provider,
    providerLabel: getPiProviderLabel(provider),
    reasoning,
    ...(reasoning.kind === 'enum'
      ? {
        defaultEffort: reasoning.default,
        effortLevels: [...reasoning.levels],
      }
      : {}),
  };
}

export function parsePiRpcModels(rawModels) {
  const models = [];
  const seen = new Set();
  for (const rawModel of Array.isArray(rawModels) ? rawModels : []) {
    const model = buildPiModelRecord(rawModel);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models;
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
      provider,
      providerLabel: getPiProviderLabel(provider),
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

function readPiRpcModelCatalog(command, options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 20_000;
    const child = spawn(command, ['--mode', 'rpc', '--no-session', '--no-approve'], {
      env: options.env || process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let settled = false;
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let stateResponse = null;
    let modelsResponse = null;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed) child.kill('SIGTERM');
      if (error) reject(error);
      else resolve(value);
    };
    const maybeFinish = () => {
      if (!stateResponse || !modelsResponse) return;
      if (modelsResponse.success !== true) {
        finish(new Error(modelsResponse.error || 'Pi RPC model discovery failed'));
        return;
      }
      const rawModels = modelsResponse.data?.models || [];
      const models = parsePiRpcModels(rawModels);
      const currentModel = stateResponse.success === true ? stateResponse.data?.model : null;
      const currentRoute = buildPiModelRouteId(currentModel?.provider, currentModel?.id);
      finish(null, { models, currentRoute });
    };
    const handleLine = (line) => {
      const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (!normalized.trim()) return;
      let event;
      try {
        event = JSON.parse(normalized);
      } catch {
        return;
      }
      if (event?.id === 'remotelab-state') stateResponse = event;
      if (event?.id === 'remotelab-models') modelsResponse = event;
      maybeFinish();
    };
    const timer = setTimeout(() => {
      finish(new Error(`Pi RPC model discovery timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString('utf8');
      while (true) {
        const newlineIndex = stdoutBuffer.indexOf('\n');
        if (newlineIndex === -1) break;
        const line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        handleLine(line);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderrBuffer = `${stderrBuffer}${chunk.toString('utf8')}`.slice(-4_000);
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (stdoutBuffer) handleLine(stdoutBuffer);
      if (!settled) {
        finish(new Error(
          `Pi RPC model discovery exited with code ${code}${stderrBuffer ? `: ${stderrBuffer.trim()}` : ''}`,
        ));
      }
    });
    child.stdin.on('error', (error) => finish(error));
    child.stdin.write(`${JSON.stringify({ id: 'remotelab-state', type: 'get_state' })}\n`);
    child.stdin.write(`${JSON.stringify({ id: 'remotelab-models', type: 'get_available_models' })}\n`);
  });
}

function buildPiCatalog(models, preferredRoute = '') {
  const preferredModel = models.find((model) => model.id === preferredRoute)
    || models.find((model) => model.id === 'openai-codex/gpt-5.6-sol')
    || models.find((model) => model.id.startsWith('openai-codex/'))
    || models[0]
    || null;
  const reasoning = preferredModel?.reasoning || { kind: 'none', label: 'Thinking' };
  return {
    models,
    effortLevels: reasoning.kind === 'enum' ? [...reasoning.levels] : null,
    defaultModel: preferredModel?.id || null,
    reasoning,
  };
}

export async function discoverPiModels(options = {}) {
  const refresh = options.refresh === true;
  const now = Date.now();
  if (!refresh && cachedCatalog && now - cachedAt < PI_MODEL_CACHE_TTL_MS) {
    return cachedCatalog;
  }

  const command = trimString(options.command) || 'pi';
  try {
    const rpcCatalog = await readPiRpcModelCatalog(command, options);
    cachedCatalog = buildPiCatalog(rpcCatalog.models, rpcCatalog.currentRoute);
  } catch (rpcError) {
    const { stdout } = await execFileAsync(command, ['--list-models'], {
      env: options.env || process.env,
      timeout: Number.isFinite(options.timeoutMs) ? options.timeoutMs : 20_000,
      maxBuffer: 5 * 1024 * 1024,
    });
    const models = parsePiModelList(stdout);
    cachedCatalog = buildPiCatalog(models);
    console.warn(`[pi-models] RPC metadata unavailable; using list fallback: ${rpcError.message}`);
  }
  cachedAt = now;
  return cachedCatalog;
}
