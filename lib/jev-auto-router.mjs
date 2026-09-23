import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { CONFIG_DIR } from './config.mjs';

export const JEV_AUTO_MODEL_ID = 'auto';

const DEFAULT_API_URL = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_JEV_MODEL = 'jev-latest';
const DEFAULT_TIMEOUT_MS = 1500;
const MAX_TASK_CHARS = 16_000;
const DEFAULT_TIER_CONFIG_FILE = join(CONFIG_DIR, 'jev-routing.json');
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

export const DEFAULT_JEV_TIER_PROFILES = Object.freeze({
  sota: Object.freeze({ model: 'gpt-6-astra', effort: 'xhigh' }),
  quality: Object.freeze({ model: 'gpt-6-sol', effort: 'high' }),
  balanced: Object.freeze({ model: 'gpt-6-sol', effort: 'medium' }),
  economy: Object.freeze({ model: 'gpt-6-luna', effort: 'low' }),
});

const TIER_NAMES = Object.freeze(Object.keys(DEFAULT_JEV_TIER_PROFILES));
const DOWNGRADE_CONFIDENCE = Object.freeze({ balanced: 0.6, economy: 0.8 });
const QUALITY_PROBABILITY_FLOOR = Object.freeze({ balanced: 0.25, economy: 0.1 });
const SOTA_CONFIDENCE_FLOOR = 0.75;

const QUESTIONS = Object.freeze({
  service_tier: {
    type: 'choice',
    instructions: 'Route the entire new RemoteLab Session, not merely the apparent size of its first message. Choose quality by default. Choose sota only when the user explicitly asks for the strongest or SOTA model, maximum reasoning, or explicitly says this task is extremely important and should receive the highest-quality treatment. Do not infer sota merely from technical difficulty or risk. Downgrade only with affirmative evidence that the whole task fits a lower tier. Short prompts can begin serious work. Treat Chinese and English equivalents the same.',
    criteria: {
      sota: 'Exceptional explicit upgrade. The user directly requests the strongest, SOTA, frontier, GPT-6/Astra, xhigh, maximum-quality, or no-compromise treatment, or explicitly says the task is extremely important and asks for the highest effort. Ordinary serious, difficult, risky, production, research, and development work stays quality unless the user clearly asks to upgrade.',
      quality: 'Default for serious work: development, debugging, project decisions, research, important factual confirmation, substantial multi-step work, ambiguous intent, production or evaluation changes, difficult diagnosis, or costly-to-correct decisions. Also use quality when the user asks to infer meaning from prior conversation, quoted or forwarded material, another Session, or other context not fully stated in the prompt. Tool use or a short prompt alone does not require this tier.',
      balanced: 'Clearly bounded, low-consequence routine work or ordinary questions that need competent answers but little deep reasoning. This includes simple lookups in existing records, returning a known machine value such as a public key, and low-risk creative or reversible operations even when one or a few tools are needed. Mistakes must be easy to notice and fix.',
      economy: 'Only for greetings, casual banter, lightweight entertainment, or an explicit request for the cheapest or fastest acceptable answer. It must require no tools, external context, factual reliability, or consequential action.',
    },
  },
});

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function parseEnvValue(text, name) {
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const match = rawLine.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match?.[1] !== name) continue;
    return match[2].replace(/^['"]|['"]$/g, '').trim();
  }
  return '';
}

async function loadApiKey() {
  const direct = trim(process.env.TYPESAFE_API_KEY);
  if (direct) return direct;
  const keyFile = trim(process.env.TYPESAFE_KEY_FILE) || join(CONFIG_DIR, 'typesafe.env');
  try {
    return parseEnvValue(await readFile(keyFile, 'utf8'), 'TYPESAFE_API_KEY');
  } catch {
    return '';
  }
}

export async function isJevAutoConfigured() {
  return Boolean(await loadApiKey());
}

function normalizeTierProfile(tier, configured = {}) {
  const fallback = DEFAULT_JEV_TIER_PROFILES[tier];
  const model = trim(configured?.model) || fallback.model;
  const requestedEffort = trim(configured?.effort);
  const effort = EFFORT_LEVELS.has(requestedEffort) ? requestedEffort : fallback.effort;
  return Object.freeze({ model, effort });
}

export function normalizeJevTierProfiles(configured = {}) {
  return Object.freeze(Object.fromEntries(TIER_NAMES.map(tier => [
    tier,
    normalizeTierProfile(tier, configured?.[tier]),
  ])));
}

async function loadTierProfiles(options = {}) {
  if (options.tierProfiles) return normalizeJevTierProfiles(options.tierProfiles);
  const configFile = trim(options.tierConfigFile || process.env.JEV_TIER_CONFIG_FILE) || DEFAULT_TIER_CONFIG_FILE;
  try {
    return normalizeJevTierProfiles(JSON.parse(await readFile(configFile, 'utf8')));
  } catch {
    return normalizeJevTierProfiles();
  }
}

export async function getJevTierProfiles(options = {}) {
  return loadTierProfiles(options);
}

export async function resolveJevTierPreset(value, options = {}) {
  const tier = trim(value).toLowerCase();
  if (!TIER_NAMES.includes(tier)) throw new Error(`Unknown Jev tier: ${value}`);
  const profiles = await loadTierProfiles(options);
  return {
    tier,
    tool: 'codex',
    model: profiles[tier].model,
    effort: profiles[tier].effort,
    thinking: false,
  };
}

function parseChoice(answer, allowed) {
  const choice = trim(answer?.choice);
  const confidence = Number(answer?.confidence);
  const probabilities = answer?.probabilities;
  if (!allowed.includes(choice) || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error('invalid_choice');
  }
  if (!probabilities || allowed.some(option => !Number.isFinite(Number(probabilities[option])))) {
    throw new Error('invalid_probabilities');
  }
  const normalizedProbabilities = Object.fromEntries(allowed.map(option => [option, Number(probabilities[option])]));
  const sum = Object.values(normalizedProbabilities).reduce((total, value) => total + value, 0);
  if (Object.values(normalizedProbabilities).some(value => value < 0 || value > 1) || Math.abs(sum - 1) > 0.03) {
    throw new Error('invalid_probabilities');
  }
  return { choice, confidence, probabilities: normalizedProbabilities };
}

export function applyJevAutoPolicy(answers, options = {}) {
  const profiles = normalizeJevTierProfiles(options.tierProfiles);
  const decision = parseChoice(answers?.service_tier, TIER_NAMES);
  let tier = decision.choice;
  const reasons = [];

  if (tier === 'sota') {
    const upgradeSupport = Math.max(decision.confidence, decision.probabilities.sota);
    if (upgradeSupport < SOTA_CONFIDENCE_FLOOR) {
      tier = 'quality';
      reasons.push('sota_uncertain');
    }
  } else if (tier !== 'quality') {
    const confidenceThreshold = Number.isFinite(options.confidenceThreshold)
      ? options.confidenceThreshold
      : DOWNGRADE_CONFIDENCE[tier];
    const downgradeSupport = Math.max(decision.confidence, decision.probabilities[decision.choice]);
    if (downgradeSupport < confidenceThreshold) {
      tier = 'quality';
      reasons.push('tier_uncertain');
    } else if (decision.probabilities.quality >= QUALITY_PROBABILITY_FLOOR[decision.choice]) {
      tier = 'quality';
      reasons.push('quality_probability');
    }
  }

  const profile = profiles[tier];
  return {
    tool: 'codex',
    model: profile.model,
    effort: profile.effort,
    thinking: false,
    policy: {
      tier,
      requestedTier: decision.choice,
      confidence: decision.confidence,
      selectedProbability: decision.probabilities[decision.choice],
      probabilities: decision.probabilities,
      reasons,
    },
  };
}

function fallbackRoute(reason, latencyMs = 0, profiles = DEFAULT_JEV_TIER_PROFILES) {
  const quality = profiles.quality;
  return {
    tool: 'codex',
    model: quality.model,
    effort: quality.effort,
    thinking: false,
    autoRoutingReceipt: {
      provider: 'typesafe',
      status: 'fallback',
      reason,
      latencyMs,
      route: { tool: 'codex', model: quality.model, effort: quality.effort },
      resolvedAt: new Date().toISOString(),
    },
  };
}

export async function resolveJevAutoRoute(task, options = {}) {
  const profiles = await loadTierProfiles(options);
  const text = trim(task).slice(0, MAX_TASK_CHARS);
  if (!text) return fallbackRoute('empty_task', 0, profiles);
  const apiKey = trim(options.apiKey) || await loadApiKey();
  if (!apiKey) return fallbackRoute('missing_key', 0, profiles);

  const apiUrl = trim(options.apiUrl || process.env.TYPESAFE_BASE_URL) || DEFAULT_API_URL;
  const jevModel = trim(options.jevModel || process.env.TYPESAFE_DEFAULT_MODEL) || DEFAULT_JEV_MODEL;
  const timeoutMs = boundedInteger(options.timeoutMs || process.env.TYPESAFE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 100, 10_000);
  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetchImpl(apiUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: jevModel,
        state: { task: text },
        questions: QUESTIONS,
      }),
      signal: controller.signal,
    });
    if (!response.ok) return fallbackRoute(`http_${response.status}`, Math.round(performance.now() - started), profiles);
    const result = await response.json();
    const route = applyJevAutoPolicy(result?.answers || {}, { ...options, tierProfiles: profiles });
    const latencyMs = Math.round(performance.now() - started);
    return {
      tool: route.tool,
      model: route.model,
      effort: route.effort,
      thinking: route.thinking,
      autoRoutingReceipt: {
        provider: 'typesafe',
        status: 'routed',
        model: trim(result?.model) || jevModel,
        latencyMs,
        decision: route.policy,
        route: { tool: route.tool, model: route.model, effort: route.effort },
        resolvedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    const reason = error?.name === 'AbortError' ? 'timeout' : 'request_error';
    return fallbackRoute(reason, Math.round(performance.now() - started), profiles);
  } finally {
    clearTimeout(timeout);
  }
}
