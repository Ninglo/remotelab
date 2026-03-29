#!/usr/bin/env node

import { runEvomapRecipePublishWatch } from '../lib/evomap-gep-publisher.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parsePositiveInteger(value, flagName, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid ${flagName} value: ${value}`);
  }
  return parsed;
}

function printUsage(exitCode = 0, errorMessage = '') {
  const output = exitCode === 0 ? console.log : console.error;
  if (errorMessage) {
    console.error(errorMessage);
    console.error('');
  }
  output(`Usage:
  node scripts/evomap-gep-publish-watch.mjs [options]

Options:
  --profile <id>            Built-in publish profile (default: hotel-housekeeping-analysis)
  --version-tag <tag>       Version or release tag (default: v1)
  --recipe-title <text>     Override recipe title
  --price <credits>         Recipe price per execution (default: 5)
  --max-concurrent <n>      Recipe max concurrency (default: 1)
  --skip-recipe             Publish only Gene + Capsule, skip recipe creation
  --skip-validate           Skip the preflight validate call
  --attempts <n>            Full publish attempts before giving up (default: 24)
  --interval-ms <ms>        Minimum wait between attempts (default: 10000)
  --jitter-ms <ms>          Random extra wait per retry (default: 1500)
  --timeout-ms <ms>         Request timeout per API call (default: 20000)
  --request-retries <n>     Per-request retries inside one attempt
  --dry-run                 Build the bundle without calling EvoMap
  --json                    Print machine-readable JSON
  -h, --help                Show this help

Examples:
  node scripts/evomap-gep-publish-watch.mjs --version-tag 2026-03-hackathon --json
  node scripts/evomap-gep-publish-watch.mjs --version-tag 2026-03-hackathon --attempts 48 --interval-ms 300000 --json`);
  process.exit(exitCode);
}

function parseArgs(argv = []) {
  const options = {
    profileId: 'hotel-housekeeping-analysis',
    versionTag: 'v1',
    recipeTitle: '',
    pricePerExecution: 5,
    maxConcurrent: 1,
    skipRecipe: false,
    validateBeforePublish: true,
    publishAttempts: 24,
    attemptIntervalMs: 10000,
    attemptJitterMs: 1500,
    timeoutMs: 20000,
    retries: undefined,
    dryRun: false,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--profile') {
      options.profileId = trimString(argv[index + 1]) || options.profileId;
      index += 1;
      continue;
    }
    if (arg === '--version-tag') {
      options.versionTag = trimString(argv[index + 1]) || options.versionTag;
      index += 1;
      continue;
    }
    if (arg === '--recipe-title') {
      options.recipeTitle = trimString(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--price') {
      options.pricePerExecution = parsePositiveInteger(argv[index + 1], '--price', options.pricePerExecution, { min: 1, max: 9999 });
      index += 1;
      continue;
    }
    if (arg === '--max-concurrent') {
      options.maxConcurrent = parsePositiveInteger(argv[index + 1], '--max-concurrent', options.maxConcurrent, { min: 1, max: 20 });
      index += 1;
      continue;
    }
    if (arg === '--attempts') {
      options.publishAttempts = parsePositiveInteger(argv[index + 1], '--attempts', options.publishAttempts, { min: 1, max: 240 });
      index += 1;
      continue;
    }
    if (arg === '--interval-ms') {
      options.attemptIntervalMs = parsePositiveInteger(argv[index + 1], '--interval-ms', options.attemptIntervalMs, { min: 1000, max: 600000 });
      index += 1;
      continue;
    }
    if (arg === '--jitter-ms') {
      options.attemptJitterMs = parsePositiveInteger(argv[index + 1], '--jitter-ms', options.attemptJitterMs, { min: 0, max: 120000 });
      index += 1;
      continue;
    }
    if (arg === '--timeout-ms') {
      options.timeoutMs = parsePositiveInteger(argv[index + 1], '--timeout-ms', options.timeoutMs, { min: 1000, max: 120000 });
      index += 1;
      continue;
    }
    if (arg === '--request-retries') {
      options.retries = parsePositiveInteger(argv[index + 1], '--request-retries', 0, { min: 0, max: 12 });
      index += 1;
      continue;
    }
    if (arg === '--skip-recipe') {
      options.skipRecipe = true;
      continue;
    }
    if (arg === '--skip-validate') {
      options.validateBeforePublish = false;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printUsage(0);
    }
    printUsage(1, `Unknown argument: ${arg}`);
  }

  return options;
}

function renderResult(result = {}) {
  const lines = [
    `profile: ${result.profileId || ''}`,
    `releaseTag: ${result.releaseTag || ''}`,
  ];

  if (result.watch) {
    lines.push(`attemptsUsed: ${result.watch.attemptsUsed || ''}`);
    lines.push(`attemptsConfigured: ${result.watch.attemptsConfigured || ''}`);
  }
  if (result.validation) {
    lines.push(`validationStatus: ${result.validation.status || ''}`);
    lines.push(`validationBundleId: ${result.validation.bundleId || ''}`);
  }
  if (result.node?.claimUrl) lines.push(`claimUrl: ${result.node.claimUrl}`);
  lines.push(`geneAssetId: ${result.bundle?.geneAssetId || ''}`);
  lines.push(`capsuleAssetId: ${result.bundle?.capsuleAssetId || ''}`);
  if (result.bundle?.bundleId) lines.push(`bundleId: ${result.bundle.bundleId}`);
  if (result.bundle?.decision) lines.push(`bundleDecision: ${result.bundle.decision}`);
  if (result.recipe?.recipeId) lines.push(`recipeId: ${result.recipe.recipeId}`);
  if (result.recipe?.publishedStatus || result.recipe?.createdStatus) {
    lines.push(`recipeStatus: ${result.recipe.publishedStatus || result.recipe.createdStatus}`);
  }
  return `${lines.join('\n')}\n`;
}

function buildJsonError(error) {
  return {
    ok: false,
    message: error?.message || String(error),
    action: trimString(error?.action),
    status: Number.isInteger(error?.result?.status) ? error.result.status : null,
    body: error?.result?.body || null,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  try {
    const result = await runEvomapRecipePublishWatch(options);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(renderResult(result));
    }
  } catch (error) {
    if (options.json) {
      process.stdout.write(`${JSON.stringify(buildJsonError(error), null, 2)}\n`);
    } else {
      process.stderr.write(`${error?.message || String(error)}\n`);
    }
    process.exit(1);
  }
}

await main();
