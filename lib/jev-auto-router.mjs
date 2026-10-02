import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { CONFIG_DIR } from './config.mjs';
import { createSerialTaskQueue, writeJsonAtomic } from '../chat/fs-utils.mjs';

export const JEV_AUTO_MODEL_ID = 'auto';

const DEFAULT_API_URL = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_JEV_MODEL = 'jev-latest';
const DEFAULT_TIMEOUT_MS = 1500;
const MAX_CHECKLIST_TASK_CHARS = 4_000;
const CHECKLIST_YES_FLOOR = 0.7;
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
  quick: Object.freeze({ model: 'gpt-6.1-sol', effort: 'low' }),
  sota: Object.freeze({ model: 'gpt-6-astra', effort: 'xhigh' }),
  quality: Object.freeze({ model: 'gpt-6.1-sol', effort: 'xhigh' }),
  balanced: Object.freeze({ model: 'gpt-6.1-sol', effort: 'medium' }),
  economy: Object.freeze({ model: 'gpt-6-luna', effort: 'low' }),
});

const TIER_NAMES = Object.freeze(Object.keys(DEFAULT_JEV_TIER_PROFILES));
const DOWNGRADE_CONFIDENCE = Object.freeze({ quick: 0.65, balanced: 0.6, economy: 0.8 });
const QUALITY_PROBABILITY_FLOOR = Object.freeze({ quick: 0.2, balanced: 0.25, economy: 0.1 });
const SOTA_CONFIDENCE_FLOOR = 0.75;

const QUESTIONS = Object.freeze({
  service_tier: {
    type: 'choice',
    instructions: 'Route the entire new RemoteLab Session from its first user message. Choose quality if context or consequences are uncertain: GPT-6.1 Sol xhigh is the default for the vast majority of requests, including routine work. Do not reduce reasoning merely because a task seems easy or to save tokens. Choose sota proactively for a large engineering project requiring serious architecture design or implementation with coupled components and difficult system tradeoffs; the user need not name Astra. Choose quick, GPT-6.1 Sol low, when speed or a short wait is explicitly prioritized for a focused, low-risk task, or the request clearly needs an immediate lightweight response. Focused tool use is allowed in quick; urgency alone does not justify less reasoning for complex or consequential work. Balanced is a compatibility tier for an explicit medium-reasoning preference, not an automatic routine-work tier. Economy, GPT-6 Luna low, is an exceptional choice only for an explicit Luna or absolute-lowest-cost preference on a trivial, low-stakes task. Honor explicit model and effort preferences: xhigh alone does not request Astra. Treat Chinese and English equally. Short prompts can start serious work.',
    criteria: {
      quick: 'GPT-6.1 Sol low for fast turnaround, not lower model capability. Use for a bounded, low-risk answer or straightforward read/lookup when the user explicitly asks for speed, low reasoning, or an immediate lightweight response. A greeting or brief acknowledgement can qualify. Ordinary simple tasks without a latency preference remain quality. Never choose this solely because consequential work is urgent.',
      sota: 'GPT-6 Astra xhigh for large engineering projects with serious architecture design and implementation, such as redesigning a distributed runtime, defining coupled subsystem contracts, or planning and implementing a complex migration. Select proactively when broad scope, difficult tradeoffs, and cross-component correctness call for it. Also use for an explicit Astra/strongest/SOTA request. A local feature, ordinary debugging, an architecture explanation, or xhigh by itself does not require Astra; explicit GPT-6.1 Sol requests stay quality.',
      quality: 'GPT-6.1 Sol xhigh is the normal choice for almost all work: routine questions, writing, reading files, research, ordinary development, debugging, tool use, multi-step tasks, verification, and ambiguous context. Its cost makes unnecessary downgrades undesirable. Reserve the largest architecture and engineering tasks for sota; use quick when a focused low-risk request clearly prioritizes speed.',
      balanced: 'Compatibility option: GPT-6.1 Sol medium only when the user explicitly asks for medium or moderate reasoning on a bounded task. Do not select merely because work is routine, uses few tools, or seems easy; default those requests to quality.',
      economy: 'Exceptional GPT-6 Luna low use only when the user explicitly requests Luna or the absolute cheapest acceptable model for a trivial, low-stakes response with no tools, current facts, or consequential action. Speed alone means quick, never economy. Ordinary requests and uncertain cases remain quality.',
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

// A small, independent gate for the opt-in Session workboard pilot. It only
// decides whether the Harness should publish a checklist; it never invents
// checklist items or changes the selected runtime.
export async function resolveJevChecklistGate(task, options = {}) {
  const fullInput = trim(task);
  const input = fullInput.length <= MAX_CHECKLIST_TASK_CHARS
    ? fullInput
    : `${fullInput.slice(0, 2_000)}\n[...middle omitted...]\n${fullInput.slice(-1_950)}`;
  if (!input) return { status: 'skipped', reason: 'empty_task', needsChecklist: false };
  const apiKey = trim(options.apiKey) || await loadApiKey();
  if (!apiKey) return { status: 'unavailable', reason: 'missing_key', needsChecklist: null };
  const controller = new AbortController();
  const timeoutMs = boundedInteger(options.timeoutMs || process.env.TYPESAFE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 100, 10_000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await (options.fetchImpl || fetch)(trim(options.apiUrl || process.env.TYPESAFE_BASE_URL) || DEFAULT_API_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: trim(options.jevModel || process.env.TYPESAFE_DEFAULT_MODEL) || DEFAULT_JEV_MODEL,
        state: { task: input },
        questions: {
          checklist: {
            type: 'choice',
            instructions: 'Choose yes only when the user delegates substantial work with at least two independently checkable deliverables or execution stages. Choose no for a short answer, a list of simple questions, one straightforward action, or discussion without delegated execution. Do not generate checklist text. Judge Chinese and English equally.',
            criteria: {
              yes: 'Delegated multi-step work with separately verifiable outcomes.',
              no: 'Brief answers, simple questions, low-effort lists, or one-step actions.',
            },
          },
        },
      }),
      signal: controller.signal,
    });
    if (!response.ok) return { status: 'unavailable', reason: `http_${response.status}`, needsChecklist: null };
    const result = await response.json();
    const decision = parseChoice(result?.answers?.checklist, ['yes', 'no']);
    return {
      status: 'decided',
      needsChecklist: decision.choice === 'yes' && decision.probabilities.yes >= CHECKLIST_YES_FLOOR,
      confidence: decision.confidence,
      latencyMs: Math.round(performance.now() - started),
    };
  } catch (error) {
    return { status: 'unavailable', reason: error?.name === 'AbortError' ? 'timeout' : 'request_failed', needsChecklist: null };
  } finally {
    clearTimeout(timeout);
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
