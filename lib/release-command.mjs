import { execFileSync } from 'child_process';
import { join } from 'path';

import {
  activateRelease,
  clearActiveRelease,
  createReleaseSnapshot,
  listReleaseSnapshots,
  readActiveReleaseManifest,
  SOURCE_PROJECT_ROOT,
} from './release-runtime.mjs';
import { normalizeBaseUrl } from './remotelab-http-client.mjs';

const DEFAULT_RELEASE_HEALTH_TIMEOUT_MS = 30_000;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function printHelp() {
  process.stdout.write(
    `Usage:\n  remotelab release [options]\n  remotelab release rollback [options]\n  remotelab release status\n\nOptions:\n  --skip-tests             Skip the npm test gate before activating a new release\n  --skip-restart           Do not restart the chat service after switching releases\n  --skip-health            Skip the post-restart health check\n  --base-url <url>         Override the health-check base URL (default: local chat server)\n  --timeout-ms <ms>        Health-check timeout in milliseconds (default: ${DEFAULT_RELEASE_HEALTH_TIMEOUT_MS})\n  --to <releaseId>         Roll back to a specific prior release id\n  --help                   Show this help\n`,
  );
}

function parseOptions(args) {
  const options = {
    skipTests: false,
    skipRestart: false,
    skipHealth: false,
    baseUrl: '',
    timeoutMs: DEFAULT_RELEASE_HEALTH_TIMEOUT_MS,
    targetReleaseId: '',
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '--skip-tests':
        options.skipTests = true;
        break;
      case '--skip-restart':
        options.skipRestart = true;
        break;
      case '--skip-health':
        options.skipHealth = true;
        break;
      case '--base-url':
        index += 1;
        options.baseUrl = trimString(args[index]);
        if (!options.baseUrl) {
          throw new Error('Missing value for --base-url');
        }
        break;
      case '--timeout-ms':
        index += 1;
        options.timeoutMs = parsePositiveInteger(args[index], DEFAULT_RELEASE_HEALTH_TIMEOUT_MS);
        break;
      case '--to':
        index += 1;
        options.targetReleaseId = trimString(args[index]);
        if (!options.targetReleaseId) {
          throw new Error('Missing value for --to');
        }
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown release option: ${arg}`);
    }
  }

  if (options.skipRestart && !options.skipHealth) {
    throw new Error('--skip-health is required when --skip-restart is set');
  }
  return options;
}

function runReleaseTests() {
  execFileSync('npm', ['run', 'test:release-gate'], {
    cwd: SOURCE_PROJECT_ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      REMOTELAB_DISABLE_ACTIVE_RELEASE: '1',
    },
  });
}

function restartChatService() {
  execFileSync('bash', [join(SOURCE_PROJECT_ROOT, 'restart.sh'), 'chat'], {
    cwd: SOURCE_PROJECT_ROOT,
    stdio: 'inherit',
  });
}

function releaseMatchesExpected(buildInfo, expectedReleaseId) {
  const actualReleaseId = trimString(buildInfo?.releaseId);
  if (expectedReleaseId === null) {
    return !actualReleaseId && trimString(buildInfo?.runtimeMode) === 'source';
  }
  return actualReleaseId === trimString(expectedReleaseId)
    && trimString(buildInfo?.runtimeMode) === 'release';
}

async function waitForHealthyRelease(options = {}) {
  const expectedReleaseId = Object.prototype.hasOwnProperty.call(options, 'expectedReleaseId')
    ? options.expectedReleaseId
    : null;
  const timeoutMs = parsePositiveInteger(options.timeoutMs, DEFAULT_RELEASE_HEALTH_TIMEOUT_MS);
  const baseUrl = normalizeBaseUrl(options.baseUrl || process.env.REMOTELAB_CHAT_BASE_URL);
  const deadline = Date.now() + timeoutMs;
  let lastError = '';

  while (Date.now() < deadline) {
    try {
      const buildResponse = await fetch(`${baseUrl}/api/build-info`, {
        cache: 'no-store',
        redirect: 'manual',
      });
      if (buildResponse.ok) {
        const buildInfo = await buildResponse.json().catch(() => null);
        if (buildInfo && releaseMatchesExpected(buildInfo, expectedReleaseId)) {
          const loginResponse = await fetch(`${baseUrl}/login`, {
            cache: 'no-store',
            redirect: 'manual',
          });
          if (loginResponse.status === 200) {
            return { baseUrl, buildInfo };
          }
          lastError = `login returned ${loginResponse.status}`;
        } else {
          lastError = `build-info reported runtime=${trimString(buildInfo?.runtimeMode) || 'unknown'} release=${trimString(buildInfo?.releaseId) || 'source'}`;
        }
      } else {
        lastError = `build-info returned ${buildResponse.status}`;
      }
    } catch (error) {
      lastError = error.message || String(error);
    }

    await new Promise((resolve) => setTimeout(resolve, 750));
  }

  throw new Error(`Health check timed out for ${baseUrl}${lastError ? ` (${lastError})` : ''}`);
}

async function rollbackToManifest(targetManifest, options = {}) {
  if (targetManifest) {
    await activateRelease(targetManifest);
  } else {
    await clearActiveRelease();
  }
  if (options.skipRestart) {
    return null;
  }
  restartChatService();
  if (options.skipHealth) {
    return null;
  }
  return waitForHealthyRelease({
    baseUrl: options.baseUrl,
    timeoutMs: options.timeoutMs,
    expectedReleaseId: targetManifest ? targetManifest.releaseId : null,
  });
}

async function runCreateRelease(options) {
  const previousActive = await readActiveReleaseManifest();

  if (!options.skipTests) {
    process.stdout.write('Running release test gate...\n');
    runReleaseTests();
  }

  process.stdout.write('Creating release snapshot...\n');
  const releaseMetadata = await createReleaseSnapshot();
  await activateRelease(releaseMetadata);

  try {
    if (!options.skipRestart) {
      process.stdout.write(`Activating release ${releaseMetadata.releaseId}...\n`);
      restartChatService();
    }

    let healthResult = null;
    if (!options.skipHealth) {
      healthResult = await waitForHealthyRelease({
        baseUrl: options.baseUrl,
        timeoutMs: options.timeoutMs,
        expectedReleaseId: releaseMetadata.releaseId,
      });
    }

    process.stdout.write(`Release ${releaseMetadata.releaseId} is active`);
    if (healthResult?.baseUrl) {
      process.stdout.write(` at ${healthResult.baseUrl}`);
    }
    process.stdout.write('\n');
    return 0;
  } catch (error) {
    process.stderr.write(`Release ${releaseMetadata.releaseId} failed: ${error.message || String(error)}\n`);
    process.stderr.write('Restoring previous release...\n');
    try {
      await rollbackToManifest(previousActive, options);
    } catch (rollbackError) {
      process.stderr.write(`Rollback failed: ${rollbackError.message || String(rollbackError)}\n`);
    }
    throw error;
  }
}

async function runRollbackRelease(options) {
  const activeRelease = await readActiveReleaseManifest();
  const releases = await listReleaseSnapshots();
  const targetRelease = options.targetReleaseId
    ? releases.find((release) => release.releaseId === options.targetReleaseId)
    : releases.find((release) => release.releaseId !== activeRelease?.releaseId);

  if (!targetRelease) {
    throw new Error(options.targetReleaseId
      ? `Release not found: ${options.targetReleaseId}`
      : 'No previous release is available to roll back to');
  }

  const previousActive = activeRelease;
  await activateRelease(targetRelease);
  try {
    if (!options.skipRestart) {
      process.stdout.write(`Rolling back to ${targetRelease.releaseId}...\n`);
      restartChatService();
    }
    if (!options.skipHealth) {
      await waitForHealthyRelease({
        baseUrl: options.baseUrl,
        timeoutMs: options.timeoutMs,
        expectedReleaseId: targetRelease.releaseId,
      });
    }
    process.stdout.write(`Rollback complete: ${targetRelease.releaseId}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`Rollback failed: ${error.message || String(error)}\n`);
    process.stderr.write('Restoring previous active release...\n');
    try {
      await rollbackToManifest(previousActive, options);
    } catch (restoreError) {
      process.stderr.write(`Restore failed: ${restoreError.message || String(restoreError)}\n`);
    }
    throw error;
  }
}

async function runReleaseStatus() {
  const activeRelease = await readActiveReleaseManifest();
  const releases = await listReleaseSnapshots();
  process.stdout.write(`${JSON.stringify({ activeRelease, releases }, null, 2)}\n`);
  return 0;
}

export async function runReleaseCommand(args = []) {
  const [subcommand, ...rest] = args;
  if (subcommand === '--help' || subcommand === '-h') {
    printHelp();
    return 0;
  }
  if (subcommand === 'status') {
    return runReleaseStatus();
  }

  if (subcommand === 'rollback') {
    const options = parseOptions(rest);
    if (options.help) {
      printHelp();
      return 0;
    }
    return runRollbackRelease(options);
  }

  const options = parseOptions(args);
  if (options.help) {
    printHelp();
    return 0;
  }
  return runCreateRelease(options);
}
