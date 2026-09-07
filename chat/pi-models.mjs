import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { PI_AGENT_DIR } from '../lib/config.mjs';
import { getPiBaselineModels } from '../lib/codex-model-catalog.mjs';
import { ensurePiModelBaseline } from './pi-model-baseline.mjs';
import { PRODUCT_DEFAULT_CODEX_MODEL, PRODUCT_DEFAULT_CODEX_EFFORT } from '../lib/legacy-micro-agent.mjs';

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
const PI_PROVIDER_RECOMMENDATIONS = Object.freeze({
  'openai-codex': Object.freeze({ modelId: PRODUCT_DEFAULT_CODEX_MODEL, effort: PRODUCT_DEFAULT_CODEX_EFFORT }),
  'glm-api': Object.freeze({ modelId: 'glm-5.3', effort: 'max' }),
  moonshotai: Object.freeze({ modelId: 'kimi-k3', effort: 'max' }),
});

let cachedCatalog = null;
let cachedAt = 0;
let cachedKey = '';

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

function getPreferredPiThinkingLevel(model) {
  if (model?.provider === 'moonshotai' && model?.id === 'kimi-k3') {
    // Kimi's API reference defines max as K3's native default.
    return 'max';
  }
  if (model?.provider === 'glm-api' && /^glm-5\.3(?:-|$)/.test(model?.id || '')) {
    // GLM-5.3 and GLM-5.3-Flash always reason; official docs use max by default.
    return 'max';
  }
  return 'medium';
}

function resolveDefaultPiThinkingLevel(levels, preferred = 'medium') {
  if (levels.includes(preferred)) return preferred;
  const preferredIndex = PI_THINKING_LEVELS.indexOf(preferred);
  for (let index = preferredIndex + 1; index < PI_THINKING_LEVELS.length; index += 1) {
    if (levels.includes(PI_THINKING_LEVELS[index])) return PI_THINKING_LEVELS[index];
  }
  for (let index = preferredIndex - 1; index >= 0; index -= 1) {
    if (levels.includes(PI_THINKING_LEVELS[index])) return PI_THINKING_LEVELS[index];
  }
  return levels[0];
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
    const enabledLevel = resolveDefaultPiThinkingLevel(
      levels.filter((level) => level !== 'off'),
      getPreferredPiThinkingLevel(model),
    );
    if (!enabledLevel) return { kind: 'none', label: 'Thinking' };
    return {
      kind: 'enum',
      label: 'Thinking',
      levels: ['off', enabledLevel],
      default: enabledLevel,
    };
  }

  const defaultLevel = resolveDefaultPiThinkingLevel(
    levels,
    getPreferredPiThinkingLevel(model),
  );
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
  const recommendation = PI_PROVIDER_RECOMMENDATIONS[provider];
  const providerDefault = recommendation?.modelId === modelId;
  const recommendedEffort = providerDefault
    && reasoning.kind === 'enum'
    && reasoning.levels.includes(recommendation.effort)
    ? recommendation.effort
    : reasoning.default;
  const resolvedReasoning = recommendedEffort && recommendedEffort !== reasoning.default
    ? { ...reasoning, default: recommendedEffort }
    : reasoning;
  return {
    id,
    label: modelId,
    provider,
    providerLabel: getPiProviderLabel(provider),
    ...(providerDefault ? { providerDefault: true } : {}),
    reasoning: resolvedReasoning,
    ...(resolvedReasoning.kind === 'enum'
      ? {
        defaultEffort: resolvedReasoning.default,
        effortLevels: [...resolvedReasoning.levels],
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

export function mergePiModelCatalog(discovered = []) {
  const baseline = parsePiRpcModels(getPiBaselineModels());
  const byId = new Map(discovered.map((model) => [model.id, model]));
  const baselineIds = new Set(baseline.map((model) => model.id));
  // Membership and order come from RemoteLab; discovered metadata reflects
  // the actual runtime (including explicit user overrides). Extra routes stay.
  return [
    ...baseline.map((model) => byId.get(model.id) || model),
    ...discovered.filter((model) => !baselineIds.has(model.id)),
  ];
}

function buildPiCatalog(discovered, preferredRoute = '') {
  const models = mergePiModelCatalog(discovered);
  const preferredModel = models.find((model) => model.id === preferredRoute)
    || models.find((model) => model.id === `openai-codex/${PRODUCT_DEFAULT_CODEX_MODEL}`)
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
  const command = trimString(options.command) || 'pi';
  const env = { ...(options.env || process.env) };
  env.PI_CODING_AGENT_DIR = trimString(env.REMOTELAB_MACHINE_PI_AGENT_DIR)
    || trimString(env.PI_CODING_AGENT_DIR) || PI_AGENT_DIR;
  const cacheKey = JSON.stringify([command, env.PI_CODING_AGENT_DIR]);
  if (!refresh && cachedCatalog && cachedKey === cacheKey
      && Date.now() - cachedAt < PI_MODEL_CACHE_TTL_MS) {
    return cachedCatalog;
  }

  // Also register the baseline with Pi itself, not just the product picker.
  // A broken local config is an explicit error, not a fabricated usable list.
  await ensurePiModelBaseline(env.PI_CODING_AGENT_DIR);
  let catalog;
  try {
    const rpcCatalog = await readPiRpcModelCatalog(command, { ...options, env });
    catalog = buildPiCatalog(rpcCatalog.models, rpcCatalog.currentRoute);
  } catch (rpcError) {
    try {
      const { stdout } = await execFileAsync(command, ['--list-models'], {
        env,
        timeout: Number.isFinite(options.timeoutMs) ? options.timeoutMs : 20_000,
        maxBuffer: 5 * 1024 * 1024,
      });
      // The text table cannot describe effort holes. Use the baseline's exact
      // Pi controls for known models rather than advertising every level.
      const baseline = new Map(parsePiRpcModels(getPiBaselineModels()).map((model) => [model.id, model]));
      const models = parsePiModelList(stdout).map((model) => baseline.get(model.id) || model);
      catalog = buildPiCatalog(models);
      console.warn(`[pi-models] RPC metadata unavailable; using list supplement: ${rpcError.message}`);
    } catch (error) {
      catalog = { ...buildPiCatalog([]), discoveryError: error.message };
      console.warn(`[pi-models] Native discovery unavailable; showing RemoteLab baseline: ${error.message}`);
    }
  }
  cachedCatalog = catalog;
  cachedKey = cacheKey;
  cachedAt = Date.now();
  return catalog;
}
