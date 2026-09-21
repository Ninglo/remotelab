import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { CONFIG_DIR } from './config.mjs';

export const JEV_AUTO_MODEL_ID = 'auto';

const DEFAULT_API_URL = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_JEV_MODEL = 'jev-latest';
const DEFAULT_TIMEOUT_MS = 1500;
const MAX_TASK_CHARS = 16_000;
const HIGH_RISK_PROBABILITY_THRESHOLD = 0.25;

const MODEL_IDS = Object.freeze({
  luna: 'gpt-5.6-luna',
  sol: 'gpt-5.6-sol',
  astra: 'gpt-6-astra',
});

const MODEL_RANK = Object.freeze({ luna: 0, sol: 1, astra: 2 });
const DEPTH_RANK = Object.freeze({ quick: 0, balanced: 1, deep: 2, maximum: 3 });
const DEPTH_EFFORT = Object.freeze({ quick: 'low', balanced: 'medium', deep: 'high', maximum: 'xhigh' });

const QUESTIONS = Object.freeze({
  model_tier: {
    type: 'choice',
    instructions: 'Choose the least expensive Codex model tier that can complete the whole task reliably, including diagnosis and verification. Judge semantic equivalents the same regardless of language.',
    criteria: {
      luna: 'Mechanical or tightly scoped work: direct reads, renames, formatting, tiny edits, or one-step answers.',
      sol: 'Standard implementation and analysis: clear multi-file changes, focused tests, ordinary refactors, and routine debugging.',
      astra: 'Frontier reasoning: ambiguity, race conditions, security, production recovery, architecture, high-impact migrations, or unclear root causes.',
    },
  },
  depth: {
    type: 'choice',
    instructions: 'Choose the reasoning depth needed to complete and verify the whole task.',
    criteria: {
      quick: 'Straightforward execution with little analysis.',
      balanced: 'Some careful reasoning and verification.',
      deep: 'Substantial multi-step reasoning.',
      maximum: 'The hardest or highest-risk work.',
    },
  },
  risk: {
    type: 'choice',
    instructions: 'Classify the consequence and uncertainty risk of assigning too weak a model. Treat security, production recovery, concurrency races, destructive changes, migrations, architecture, and unclear root causes as high risk.',
    criteria: {
      low: 'Read-only, mechanical, tightly scoped, and easily reversible.',
      medium: 'Ordinary implementation or analysis with focused verification.',
      high: 'Security-sensitive, production-impacting, destructive, concurrent, architectural, ambiguous, or hard to recover.',
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

function maxByRank(current, floor, ranks) {
  return ranks[current] >= ranks[floor] ? current : floor;
}

export function applyJevAutoPolicy(answers, { confidenceThreshold = 0.6 } = {}) {
  const model = parseChoice(answers?.model_tier, Object.keys(MODEL_RANK));
  const depth = parseChoice(answers?.depth, Object.keys(DEPTH_RANK));
  const risk = parseChoice(answers?.risk, ['low', 'medium', 'high']);
  let tier = model.choice;
  let selectedDepth = depth.choice;
  const reasons = [];

  const highRiskProbability = risk.probabilities.high;
  if (risk.choice === 'high' || highRiskProbability >= HIGH_RISK_PROBABILITY_THRESHOLD) {
    tier = 'astra';
    selectedDepth = maxByRank(selectedDepth, 'deep', DEPTH_RANK);
    reasons.push(risk.choice === 'high' ? 'high_risk_floor' : 'high_risk_probability');
  } else if (model.confidence < confidenceThreshold) {
    tier = Object.keys(MODEL_RANK).find(candidate => MODEL_RANK[candidate] === Math.min(2, MODEL_RANK[tier] + 1));
    reasons.push('model_uncertain');
  }

  if (depth.confidence < confidenceThreshold) {
    selectedDepth = maxByRank(selectedDepth, 'balanced', DEPTH_RANK);
    reasons.push('depth_uncertain');
  }

  return {
    tool: 'codex',
    model: MODEL_IDS[tier],
    effort: DEPTH_EFFORT[selectedDepth],
    thinking: false,
    policy: {
      tier,
      depth: selectedDepth,
      risk: risk.choice,
      confidence: {
        model: model.confidence,
        depth: depth.confidence,
        risk: risk.confidence,
        highRiskProbability,
      },
      reasons,
    },
  };
}

function fallbackRoute(reason, latencyMs = 0) {
  return {
    tool: 'codex',
    model: MODEL_IDS.astra,
    effort: 'high',
    thinking: false,
    autoRoutingReceipt: {
      provider: 'typesafe',
      status: 'fallback',
      reason,
      latencyMs,
      route: { tool: 'codex', model: MODEL_IDS.astra, effort: 'high' },
      resolvedAt: new Date().toISOString(),
    },
  };
}

export async function resolveJevAutoRoute(task, options = {}) {
  const text = trim(task).slice(0, MAX_TASK_CHARS);
  if (!text) return fallbackRoute('empty_task');
  const apiKey = trim(options.apiKey) || await loadApiKey();
  if (!apiKey) return fallbackRoute('missing_key');

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
    if (!response.ok) return fallbackRoute(`http_${response.status}`, Math.round(performance.now() - started));
    const result = await response.json();
    const route = applyJevAutoPolicy(result?.answers || {});
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
    return fallbackRoute(reason, Math.round(performance.now() - started));
  } finally {
    clearTimeout(timeout);
  }
}
