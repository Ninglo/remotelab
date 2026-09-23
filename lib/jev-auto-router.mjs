import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { CONFIG_DIR } from './config.mjs';
import { createSerialTaskQueue, writeJsonAtomic } from '../chat/fs-utils.mjs';

export const JEV_AUTO_MODEL_ID = 'auto';

const DEFAULT_API_URL = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_JEV_MODEL = 'jev-latest';
const DEFAULT_TIMEOUT_MS = 1500;
const MAX_TASK_CHARS = 16_000;
const DEFAULT_TIER_CONFIG_FILE = join(CONFIG_DIR, 'jev-routing.json');
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const writeRoutingSettings = createSerialTaskQueue();

export const DEFAULT_AUTO_QUICK_PROMPT = [
  'This Session was routed to Quick for a brief, low-risk request.',
  'Answer directly and concisely in the user\'s language. Return only the final answer; omit progress updates and unnecessary planning.',
  'Use the context already supplied. Use tools when the user explicitly requests them or the requested result requires live facts, private data, file inspection, or an external action.',
  'Keep necessary tool use focused. Do not refuse a supported request because this Session was routed to Quick.',
].join(' ');

export const DEFAULT_JEV_TIER_PROFILES = Object.freeze({
  quick: Object.freeze({ model: 'gpt-6-sol', effort: 'low' }),
  sota: Object.freeze({ model: 'gpt-6-astra', effort: 'xhigh' }),
  quality: Object.freeze({ model: 'gpt-6-sol', effort: 'xhigh' }),
  balanced: Object.freeze({ model: 'gpt-6-sol', effort: 'medium' }),
  economy: Object.freeze({ model: 'gpt-6-luna', effort: 'low' }),
});

const TIER_NAMES = Object.freeze(Object.keys(DEFAULT_JEV_TIER_PROFILES));
const DOWNGRADE_CONFIDENCE = Object.freeze({ quick: 0.65, balanced: 0.6, economy: 0.8 });
const QUALITY_PROBABILITY_FLOOR = Object.freeze({ quick: 0.2, balanced: 0.25, economy: 0.1 });
const SOTA_CONFIDENCE_FLOOR = 0.75;

const QUESTIONS = Object.freeze({
  service_tier: {
    type: 'choice',
    instructions: 'Route the entire new RemoteLab Session from its first user message. Choose quality if context or consequences are uncertain. Choose quick for self-contained, brief, low-stakes conversational work that can be answered from the supplied text without tools or external facts. Any request to inspect a file, attachment, mailbox, calendar, prior chat, or current external fact is not quick, even if the answer is one word; use at least balanced. Quick uses a strong model with low reasoning effort. A request to hurry does not make consequential work quick. Choose balanced for bounded, low-risk work that can need a few tools. Choose economy only when the user explicitly prioritizes the cheapest acceptable response for casual work. Choose sota only when the user explicitly asks for the strongest model or maximum reasoning. Treat Chinese and English equally. Short prompts can start serious work.',
    criteria: {
      quick: 'Brief, self-contained, low-stakes answers, rewrites, translations, simple explanations or greetings using only text inside the message; no tools, file or attachment reads, prior chat, current facts or consequential action. Select because the task is simple, not merely because the user says fast.',
      sota: 'Exceptional explicit upgrade. The user directly requests the strongest, SOTA, frontier, GPT-6/Astra, xhigh, maximum-quality, or no-compromise treatment, or explicitly says the task is extremely important and asks for the highest effort. Ordinary serious, difficult, risky, production, research, and development work stays quality unless the user clearly asks to upgrade.',
      quality: 'Default for ambiguous, serious or consequential work, research, development, debugging, multi-step tasks, production, evaluation, current facts that need verification, or references to conversation and missing context. Also use this when speed is requested for a consequential task.',
      balanced: 'Bounded, low-risk routine work such as reading a known file, calendar entry, simple calculation or formatting with supplied data; at most a few straightforward tool actions; errors easy to spot and fix.',
      economy: 'Only explicit lowest-cost preference for casual, low-stakes work. Cheapest is not the same as fastest. Do not use for facts, tools or consequential action.',
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

export async function getJevRoutingSettings(options = {}) {
  const configFile = trim(options.tierConfigFile || process.env.JEV_TIER_CONFIG_FILE) || DEFAULT_TIER_CONFIG_FILE;
  let configured = {};
  try { configured = JSON.parse(await readFile(configFile, 'utf8')); } catch {}
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) configured = {};
  return {
    tiers: normalizeJevTierProfiles(configured),
    quickPrompt: trim(configured.quickPrompt) || DEFAULT_AUTO_QUICK_PROMPT,
  };
}

export async function updateJevRoutingSettings(patch = {}, options = {}) {
  const configFile = trim(options.tierConfigFile || process.env.JEV_TIER_CONFIG_FILE) || DEFAULT_TIER_CONFIG_FILE;
  return writeRoutingSettings(async () => {
    let stored = {};
    try { stored = JSON.parse(await readFile(configFile, 'utf8')); } catch {}
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) stored = {};
    const next = { ...stored };
    if (Object.prototype.hasOwnProperty.call(patch, 'tiers')) {
      if (!patch.tiers || typeof patch.tiers !== 'object' || Array.isArray(patch.tiers)) throw new Error('tiers must be an object');
      for (const [tier, profile] of Object.entries(patch.tiers)) {
        if (!TIER_NAMES.includes(tier)) throw new Error(`Unknown tier: ${tier}`);
        if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error(`Invalid profile: ${tier}`);
        const model = trim(profile.model);
        const effort = trim(profile.effort);
        if (!model || model === JEV_AUTO_MODEL_ID || model.length > 120 || !EFFORT_LEVELS.has(effort)) throw new Error(`Invalid model or effort: ${tier}`);
        next[tier] = { model, effort };
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'quickPrompt')) {
      const quickPrompt = trim(patch.quickPrompt);
      if (!quickPrompt || quickPrompt.length > 4000) throw new Error('quickPrompt must be 1–4000 characters');
      next.quickPrompt = quickPrompt;
    }
    await writeJsonAtomic(configFile, next);
    return getJevRoutingSettings({ tierConfigFile: configFile });
  });
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
