#!/usr/bin/env node

import { execFile as execFileCallback } from 'child_process';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { AUTH_FILE, CHAT_PORT } from '../lib/config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const DEFAULT_CHAT_BASE_URL = `http://127.0.0.1:${CHAT_PORT}`;
const DEFAULT_SESSION_TOOL = 'codex';
const DEFAULT_BRANCHES = ['main', 'master'];
const DEFAULT_EVENTS = ['push'];
const DEFAULT_BOOTSTRAP_HOURS = 24;
const DEFAULT_LIMIT = 20;
const DEFAULT_SETTLE_MINUTES = 5;
const DEFAULT_MAX_LOG_LINES = 120;
const DEFAULT_MAX_LOG_CHARS = 12000;
const MAX_HANDLED_RUNS = 500;
const FAILURE_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);
const execFileAsync = promisify(execFileCallback);

function usage(exitCode = 0) {
  const message = `Usage:
  node scripts/github-ci-auto-repair.mjs --repo <owner/repo> [options]

Options:
  --repo <owner/repo>         GitHub repository to watch
  --branch <name>             Branch to watch (repeatable; default: main,master)
  --branches <a,b>            Comma-separated branches to watch
  --event <name>              GitHub event to watch (repeatable; default: push)
  --events <a,b>              Comma-separated events to watch
  --workflow <name>           Workflow filter by name/path/id (repeatable)
  --workflows <a,b>           Comma-separated workflow filters
  --chat-base-url <url>       RemoteLab base URL (default: ${DEFAULT_CHAT_BASE_URL})
  --session-folder <path>     Local repo path used for RemoteLab sessions (default: ${PROJECT_ROOT})
  --session-tool <tool>       Tool used for RemoteLab sessions (default: ${DEFAULT_SESSION_TOOL})
  --model <id>                Optional model override for submitted messages
  --effort <level>            Optional effort override for submitted messages
  --thinking                  Enable thinking for submitted messages
  --bootstrap-hours <hours>   Lookback window on first run (default: ${DEFAULT_BOOTSTRAP_HOURS})
  --limit <count>             Max workflow runs fetched per branch (default: ${DEFAULT_LIMIT})
  --settle-minutes <mins>     Wait before reacting to a failed run (default: ${DEFAULT_SETTLE_MINUTES})
  --max-log-lines <count>     Max failed log lines included in the prompt (default: ${DEFAULT_MAX_LOG_LINES})
  --max-log-chars <count>     Max failed log characters included in the prompt (default: ${DEFAULT_MAX_LOG_CHARS})
  --state-file <path>         Override state file path
  --snapshot-dir <path>       Override snapshot directory
  --dry-run                   Print candidates without creating RemoteLab sessions
  --json                      Print machine-readable JSON summary
  --verbose                   Print extra details
  -h, --help                  Show this help

Behavior:
  - Polls GitHub Actions runs through gh CLI
  - Looks at the latest matching run for each branch/workflow group
  - Skips runs that are still in progress, already handled, or still within the settle window
  - Creates a RemoteLab session with failure context and a repair task when a latest branch CI run is red
`;
  console.log(message);
  process.exit(exitCode);
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function splitCsv(value) {
  return trimString(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function nowIso() {
  return new Date().toISOString();
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function repoKey(repo) {
  return trimString(repo).replace(/[^a-zA-Z0-9._-]+/g, '__');
}

function slugify(value, fallback = 'item') {
  const normalized = trimString(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function defaultStateFile(repo) {
  return join(homedir(), '.config', 'remotelab', 'github-ci-auto-repair', `${repoKey(repo)}.json`);
}

function defaultSnapshotDir(repo) {
  return join(homedir(), '.config', 'remotelab', 'github-ci-auto-repair', 'snapshots', repoKey(repo));
}

async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

async function ensureParentDir(path) {
  await ensureDir(dirname(path));
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(path, value) {
  await ensureParentDir(path);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function normalizeBaseUrl(value) {
  return trimString(value || process.env.REMOTELAB_CHAT_BASE_URL || DEFAULT_CHAT_BASE_URL).replace(/\/+$/, '') || DEFAULT_CHAT_BASE_URL;
}

function parseArgs(argv = []) {
  const options = {
    repo: '',
    branches: [],
    events: [],
    workflows: [],
    chatBaseUrl: normalizeBaseUrl(''),
    sessionFolder: PROJECT_ROOT,
    sessionTool: DEFAULT_SESSION_TOOL,
    model: '',
    effort: '',
    thinking: false,
    bootstrapHours: DEFAULT_BOOTSTRAP_HOURS,
    limit: DEFAULT_LIMIT,
    settleMinutes: DEFAULT_SETTLE_MINUTES,
    maxLogLines: DEFAULT_MAX_LOG_LINES,
    maxLogChars: DEFAULT_MAX_LOG_CHARS,
    stateFile: '',
    snapshotDir: '',
    dryRun: false,
    json: false,
    verbose: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repo') {
      options.repo = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg === '--branch') {
      options.branches.push(argv[index + 1] || '');
      index += 1;
      continue;
    }
    if (arg === '--branches') {
      options.branches.push(...splitCsv(argv[index + 1] || ''));
      index += 1;
      continue;
    }
    if (arg === '--event') {
      options.events.push(argv[index + 1] || '');
      index += 1;
      continue;
    }
    if (arg === '--events') {
      options.events.push(...splitCsv(argv[index + 1] || ''));
      index += 1;
      continue;
    }
    if (arg === '--workflow') {
      options.workflows.push(argv[index + 1] || '');
      index += 1;
      continue;
    }
    if (arg === '--workflows') {
      options.workflows.push(...splitCsv(argv[index + 1] || ''));
      index += 1;
      continue;
    }
    if (arg === '--chat-base-url') {
      options.chatBaseUrl = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg === '--session-folder') {
      options.sessionFolder = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg === '--session-tool') {
      options.sessionTool = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg === '--model') {
      options.model = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg === '--effort') {
      options.effort = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg === '--thinking') {
      options.thinking = true;
      continue;
    }
    if (arg === '--bootstrap-hours') {
      options.bootstrapHours = parsePositiveInteger(argv[index + 1], DEFAULT_BOOTSTRAP_HOURS);
      index += 1;
      continue;
    }
    if (arg === '--limit') {
      options.limit = parsePositiveInteger(argv[index + 1], DEFAULT_LIMIT);
      index += 1;
      continue;
    }
    if (arg === '--settle-minutes') {
      options.settleMinutes = parseNonNegativeInteger(argv[index + 1], DEFAULT_SETTLE_MINUTES);
      index += 1;
      continue;
    }
    if (arg === '--max-log-lines') {
      options.maxLogLines = parsePositiveInteger(argv[index + 1], DEFAULT_MAX_LOG_LINES);
      index += 1;
      continue;
    }
    if (arg === '--max-log-chars') {
      options.maxLogChars = parsePositiveInteger(argv[index + 1], DEFAULT_MAX_LOG_CHARS);
      index += 1;
      continue;
    }
    if (arg === '--state-file') {
      options.stateFile = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg === '--snapshot-dir') {
      options.snapshotDir = argv[index + 1] || '';
      index += 1;
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
    if (arg === '--verbose') {
      options.verbose = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      usage(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  options.repo = trimString(options.repo);
  options.branches = unique((options.branches.length > 0 ? options.branches : DEFAULT_BRANCHES).map((value) => trimString(value)));
  options.events = unique((options.events.length > 0 ? options.events : DEFAULT_EVENTS).map((value) => trimString(value).toLowerCase()));
  options.workflows = unique(options.workflows.map((value) => trimString(value).toLowerCase()));
  options.chatBaseUrl = normalizeBaseUrl(options.chatBaseUrl);
  options.sessionFolder = trimString(options.sessionFolder || PROJECT_ROOT) || PROJECT_ROOT;
  options.sessionTool = trimString(options.sessionTool || DEFAULT_SESSION_TOOL) || DEFAULT_SESSION_TOOL;
  options.model = trimString(options.model);
  options.effort = trimString(options.effort);
  options.stateFile = trimString(options.stateFile);
  options.snapshotDir = trimString(options.snapshotDir);

  if (!options.repo) {
    throw new Error('--repo is required');
  }
  if (options.branches.length === 0) {
    throw new Error('At least one branch must be provided');
  }
  if (options.events.length === 0) {
    throw new Error('At least one event must be provided');
  }

  return options;
}

function ghEnv() {
  return {
    ...process.env,
    GH_PAGER: 'cat',
  };
}

async function runGh(args, { allowFailure = false } = {}) {
  const ghBin = trimString(process.env.GH_BIN) || 'gh';
  try {
    const result = await execFileAsync(ghBin, args, {
      encoding: 'utf8',
      env: ghEnv(),
      maxBuffer: 20 * 1024 * 1024,
    });
    return {
      ok: true,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      status: 0,
    };
  } catch (error) {
    const status = Number.isInteger(error?.code) ? error.code : 1;
    const message = trimString(error?.stderr || error?.stdout || error?.message) || `gh ${args.join(' ')} failed with exit ${status}`;
    if (allowFailure) {
      return {
        ok: false,
        stdout: error?.stdout || '',
        stderr: error?.stderr || '',
        status,
        message,
      };
    }
    throw new Error(message);
  }
}

async function runGhJson(args) {
  const result = await runGh(args);
  try {
    return JSON.parse(result.stdout || 'null');
  } catch (error) {
    throw new Error(`Failed to parse gh JSON for ${args.join(' ')}: ${error.message}`);
  }
}

async function listWorkflowRuns(repo, branch, limit) {
  const payload = await runGhJson([
    'api', '-X', 'GET', `repos/${repo}/actions/runs`,
    '-f', `branch=${branch}`,
    '-f', `per_page=${limit}`,
  ]);
  return Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : [];
}

async function loadRunJobs(repo, runId) {
  const payload = await runGhJson([
    'api', '-X', 'GET', `repos/${repo}/actions/runs/${runId}/jobs`,
    '-f', 'per_page=100',
  ]);
  return Array.isArray(payload?.jobs) ? payload.jobs : [];
}

async function loadCommit(repo, sha) {
  if (!trimString(sha)) return null;
  try {
    return await runGhJson(['api', '-X', 'GET', `repos/${repo}/commits/${sha}`]);
  } catch {
    return null;
  }
}

async function loadFailedLog(repo, runId) {
  const result = await runGh(['run', 'view', String(runId), '--repo', repo, '--log-failed'], { allowFailure: true });
  if (!result.ok) return '';
  return trimString(result.stdout);
}

function workflowLabel(run) {
  return trimString(run?.name)
    || trimString(run?.display_title)
    || trimString(run?.workflow_name)
    || basename(trimString(run?.path))
    || `workflow-${trimString(run?.workflow_id) || 'unknown'}`;
}

function workflowGroupKey(run) {
  const workflowId = trimString(String(run?.workflow_id || ''));
  if (workflowId) return workflowId;
  const path = trimString(run?.path);
  if (path) return `path:${path.toLowerCase()}`;
  return `name:${workflowLabel(run).toLowerCase()}`;
}

function runSortTimestamp(run) {
  const parsed = Date.parse(run?.updated_at || run?.created_at || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function matchesWorkflowFilters(run, filters) {
  if (!Array.isArray(filters) || filters.length === 0) return true;
  const path = trimString(run?.path).toLowerCase();
  const values = [
    trimString(run?.name).toLowerCase(),
    trimString(run?.display_title).toLowerCase(),
    trimString(run?.workflow_name).toLowerCase(),
    path,
    basename(path || '').toLowerCase(),
    trimString(String(run?.workflow_id || '')).toLowerCase(),
  ].filter(Boolean);
  return filters.some((filter) => values.some((value) => value === filter || value.includes(filter)));
}

function matchesEventFilters(run, events) {
  if (!Array.isArray(events) || events.length === 0) return true;
  return events.includes(trimString(run?.event).toLowerCase());
}

function isCompletedRun(run) {
  return trimString(run?.status).toLowerCase() === 'completed';
}

function isFailureRun(run) {
  return FAILURE_CONCLUSIONS.has(trimString(run?.conclusion).toLowerCase());
}

function latestRunGroupKey(run) {
  return `${trimString(run?.head_branch)}:${workflowGroupKey(run)}`;
}

function buildLatestRunGroups(runs, options) {
  const grouped = new Map();
  for (const run of runs) {
    if (!run) continue;
    if (!trimString(run.head_branch)) continue;
    if (!matchesEventFilters(run, options.events)) continue;
    if (!matchesWorkflowFilters(run, options.workflows)) continue;
    const key = latestRunGroupKey(run);
    const current = grouped.get(key);
    if (!current || runSortTimestamp(run) > runSortTimestamp(current)) {
      grouped.set(key, run);
    }
  }
  return [...grouped.values()].sort((left, right) => runSortTimestamp(right) - runSortTimestamp(left));
}

export function selectLatestFailureCandidates(runs, options, state, nowMs = Date.now()) {
  const firstRun = !trimString(state?.initializedAt) && !trimString(state?.lastPollAt);
  const bootstrapCutoffMs = nowMs - (options.bootstrapHours * 60 * 60 * 1000);
  const settleCutoffMs = nowMs - (options.settleMinutes * 60 * 1000);
  const latestRuns = buildLatestRunGroups(runs, options);
  const candidates = [];
  const skipped = [];

  for (const run of latestRuns) {
    const updatedMs = runSortTimestamp(run);
    const base = {
      githubRunId: run.id,
      branch: trimString(run.head_branch),
      workflow: workflowLabel(run),
      url: trimString(run.html_url),
    };
    if (!isCompletedRun(run)) {
      skipped.push({ ...base, reason: 'latest_run_in_progress' });
      continue;
    }
    if (!isFailureRun(run)) {
      skipped.push({ ...base, reason: `latest_run_${trimString(run.conclusion || 'ok') || 'ok'}` });
      continue;
    }
    if (firstRun && updatedMs > 0 && updatedMs < bootstrapCutoffMs) {
      skipped.push({ ...base, reason: 'outside_bootstrap_window' });
      continue;
    }
    if (updatedMs > settleCutoffMs) {
      skipped.push({ ...base, reason: 'within_settle_window' });
      continue;
    }
    if (state?.handledRuns?.[String(run.id)]) {
      skipped.push({ ...base, reason: 'already_handled' });
      continue;
    }
    candidates.push(run);
  }

  return { latestRuns, candidates, skipped };
}

function shortSha(value) {
  const normalized = trimString(value);
  return normalized ? normalized.slice(0, 12) : '';
}

function firstLine(text, fallback = '') {
  const normalized = trimString(text);
  if (!normalized) return fallback;
  const [line] = normalized.split(/\r?\n/, 1);
  return trimString(line) || fallback;
}

function commitSummary(commit) {
  return {
    sha: trimString(commit?.sha),
    title: firstLine(commit?.commit?.message || commit?.message || '', ''),
    url: trimString(commit?.html_url),
    author: trimString(commit?.author?.login || commit?.commit?.author?.name || ''),
  };
}

function normalizeFailedJobs(jobs) {
  return jobs
    .filter((job) => isFailureRun(job) || (Array.isArray(job?.steps) && job.steps.some((step) => isFailureRun(step))))
    .map((job) => ({
      name: trimString(job?.name) || 'unnamed-job',
      url: trimString(job?.html_url),
      conclusion: trimString(job?.conclusion),
      steps: Array.isArray(job?.steps)
        ? job.steps
          .filter((step) => isFailureRun(step))
          .map((step) => ({
            name: trimString(step?.name) || `step-${step?.number || '?'}`,
            conclusion: trimString(step?.conclusion),
            number: step?.number,
          }))
        : [],
    }));
}

export function truncateLogText(text, maxLines = DEFAULT_MAX_LOG_LINES, maxChars = DEFAULT_MAX_LOG_CHARS) {
  const normalized = String(text || '').replace(/\r\n/g, '\n');
  const limitedLines = normalized.split('\n').slice(0, Math.max(1, maxLines)).join('\n');
  if (limitedLines.length <= maxChars) return limitedLines.trim();
  return `${limitedLines.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function renderFailedJobsMarkdown(failedJobs) {
  if (!Array.isArray(failedJobs) || failedJobs.length === 0) {
    return ['(no failed jobs captured)'];
  }

  const lines = [];
  for (const job of failedJobs) {
    const suffix = job.conclusion ? ` (${job.conclusion})` : '';
    lines.push(`- ${job.name}${suffix}`);
    if (job.url) lines.push(`  - Job URL: ${job.url}`);
    if (job.steps.length > 0) {
      for (const step of job.steps) {
        const stepSuffix = step.conclusion ? ` (${step.conclusion})` : '';
        lines.push(`  - Step: ${step.name}${stepSuffix}`);
      }
    }
  }
  return lines;
}

function buildSnapshotFilename(run) {
  return `${trimString(run.head_branch) || 'branch'}-${slugify(workflowLabel(run), 'workflow')}-run-${run.id}.md`;
}

function renderSnapshot({ repo, sessionFolder, run, commit, failedJobs, failedLog }) {
  const commitInfo = commitSummary(commit);
  const lines = [
    '# GitHub CI failure snapshot',
    '',
    `- Repo: ${repo}`,
    `- Local path: ${sessionFolder}`,
    `- Branch: ${trimString(run.head_branch)}`,
    `- Workflow: ${workflowLabel(run)}`,
    `- Event: ${trimString(run.event)}`,
    `- Status: ${trimString(run.status)}`,
    `- Conclusion: ${trimString(run.conclusion)}`,
    `- GitHub Run ID: ${run.id}`,
    `- Run URL: ${trimString(run.html_url) || '(unknown)'}`,
    `- Updated At: ${trimString(run.updated_at || run.created_at) || '(unknown)'}`,
    `- Head SHA: ${trimString(run.head_sha) || '(unknown)'}`,
    `- Commit Title: ${commitInfo.title || '(unknown)'}`,
    `- Commit Author: ${commitInfo.author || '(unknown)'}`,
    `- Commit URL: ${commitInfo.url || '(unknown)'}`,
    '',
    '## Failed jobs',
    ...renderFailedJobsMarkdown(failedJobs),
    '',
    '## Failed log excerpt',
    '```text',
    trimString(failedLog) || '(none captured)',
    '```',
    '',
    '## Repair expectation',
    '- Inspect the workflow under `.github/workflows/` and reproduce the failure locally.',
    '- Fix the root cause rather than patching symptoms.',
    '- Run targeted validation first, then the relevant broader validation.',
    '- If the failure looks flaky or infra-only, stop after writing a concise diagnosis instead of pushing guesses.',
  ];
  return `${lines.join('\n')}\n`;
}

function buildSessionName(run) {
  return `CI repair: ${trimString(run.head_branch)} / ${workflowLabel(run)} / ${run.id}`;
}

function buildSessionDescription(repo, run) {
  return `GitHub Actions failure on ${repo} ${trimString(run.head_branch)} (${workflowLabel(run)} #${run.id})`;
}

function buildExternalTriggerId(repo, run) {
  return `github-ci:${repo}:run/${run.id}`;
}

function buildRequestId(repo, run) {
  return `github-ci:${repoKey(repo)}:${trimString(run.head_branch)}:${slugify(workflowLabel(run), 'workflow')}:${run.id}`;
}

function buildSessionSystemPrompt() {
  return [
    'You were triggered automatically by the RemoteLab GitHub CI repair monitor.',
    'Treat this as an autonomous repair session for a failed branch CI run.',
    'Work directly in the local repo path provided in the user message.',
    'First inspect the workflow and reproduce the failure locally with the closest commands.',
    'If you can fix and validate confidently, do so and create a remote-backed checkpoint.',
    'If the failure is flaky, infra-only, auth-related, or not reproducible, do not push guesses; leave a concise diagnosis and next action instead.',
  ].join('\n');
}

export function buildSessionMessage({ repo, sessionFolder, run, commit, failedJobs, failedLog, snapshotFile }) {
  const commitInfo = commitSummary(commit);
  const logExcerpt = truncateLogText(failedLog);
  const lines = [
    'Source: GitHub CI monitor',
    `Repo: ${repo}`,
    `Local Repo Path: ${sessionFolder}`,
    `Branch: ${trimString(run.head_branch)}`,
    `Workflow: ${workflowLabel(run)}`,
    `Event: ${trimString(run.event)}`,
    `Status: ${trimString(run.status)}`,
    `Conclusion: ${trimString(run.conclusion)}`,
    `GitHub Run ID: ${run.id}`,
    `Run URL: ${trimString(run.html_url) || '(unknown)'}`,
    `Updated At: ${trimString(run.updated_at || run.created_at) || '(unknown)'}`,
    `Head SHA: ${trimString(run.head_sha) || '(unknown)'}`,
    `Short SHA: ${shortSha(run.head_sha) || '(unknown)'}`,
    `Commit Title: ${commitInfo.title || '(unknown)'}`,
    `Commit Author: ${commitInfo.author || '(unknown)'}`,
    `Commit URL: ${commitInfo.url || '(unknown)'}`,
    `Snapshot File: ${snapshotFile}`,
    '',
    'Failed Jobs:',
    ...renderFailedJobsMarkdown(failedJobs),
    '',
    'Failed Log Excerpt:',
    '```text',
    logExcerpt || '(none captured)',
    '```',
    '',
    'Repair Task:',
    '- Work directly in the local repo path above.',
    '- Inspect `.github/workflows/` and reproduce the failure locally using the closest commands from the CI workflow.',
    '- Fix the root cause, not just the symptom.',
    '- Run targeted validation first, then broader validation that matches the touched area.',
    '- If local validation is green and the fix is solid, create a remote-backed checkpoint.',
    '- If the failure looks flaky, infra-only, or not reproducible, do not push guesses; leave a concise diagnosis and next recommendation in the session instead.',
  ];
  return lines.join('\n');
}

async function readOwnerToken() {
  const auth = await readJson(AUTH_FILE, {});
  const token = trimString(auth?.token);
  if (!token) {
    throw new Error(`No owner token found in ${AUTH_FILE}`);
  }
  return token;
}

async function loginWithToken(baseUrl, token) {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/?token=${encodeURIComponent(token)}`, {
    redirect: 'manual',
  });
  const setCookie = response.headers.get('set-cookie');
  if (response.status !== 302 || !setCookie) {
    throw new Error(`Failed to authenticate to RemoteLab at ${baseUrl} (status ${response.status})`);
  }
  return setCookie.split(';')[0];
}

async function requestJson(baseUrl, path, { method = 'GET', cookie, body } = {}) {
  const headers = {
    Accept: 'application/json',
  };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${normalizeBaseUrl(baseUrl)}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { response, json, text };
}

async function ensureAuthCookie(runtime, forceRefresh = false) {
  if (!forceRefresh && runtime.authCookie) {
    return runtime.authCookie;
  }
  if (forceRefresh) {
    runtime.authCookie = '';
    runtime.authToken = '';
  }
  if (!runtime.authToken) {
    runtime.authToken = await readOwnerToken();
  }
  runtime.authCookie = await loginWithToken(runtime.baseUrl, runtime.authToken);
  return runtime.authCookie;
}

async function requestRemoteLab(runtime, path, options = {}) {
  const cookie = await ensureAuthCookie(runtime, false);
  let result = await requestJson(runtime.baseUrl, path, { ...options, cookie });
  if ([401, 403].includes(result.response.status)) {
    const refreshedCookie = await ensureAuthCookie(runtime, true);
    result = await requestJson(runtime.baseUrl, path, { ...options, cookie: refreshedCookie });
  }
  return result;
}

async function triggerRepairSession(options, runtime, incident) {
  const externalTriggerId = buildExternalTriggerId(options.repo, incident.run);
  const requestId = buildRequestId(options.repo, incident.run);
  const sessionPayload = {
    folder: options.sessionFolder,
    tool: options.sessionTool,
    name: buildSessionName(incident.run),
    sourceId: 'github-ci',
    sourceName: 'GitHub CI',
    group: 'GitHub',
    description: buildSessionDescription(options.repo, incident.run),
    systemPrompt: buildSessionSystemPrompt(),
    externalTriggerId,
  };
  const createResult = await requestRemoteLab(runtime, '/api/sessions', {
    method: 'POST',
    body: sessionPayload,
  });
  if (!createResult.response.ok || !createResult.json?.session?.id) {
    throw new Error(createResult.json?.error || createResult.text || `Failed to create session (${createResult.response.status})`);
  }

  const messagePayload = {
    requestId,
    text: buildSessionMessage({
      repo: options.repo,
      sessionFolder: options.sessionFolder,
      run: incident.run,
      commit: incident.commit,
      failedJobs: incident.failedJobs,
      failedLog: incident.failedLog,
      snapshotFile: incident.snapshotFile,
    }),
    tool: options.sessionTool,
    thinking: options.thinking === true,
  };
  if (options.model) messagePayload.model = options.model;
  if (options.effort) messagePayload.effort = options.effort;

  const submitResult = await requestRemoteLab(runtime, `/api/sessions/${createResult.json.session.id}/messages`, {
    method: 'POST',
    body: messagePayload,
  });
  if (![200, 202].includes(submitResult.response.status) || !submitResult.json?.run?.id) {
    throw new Error(submitResult.json?.error || submitResult.text || `Failed to submit repair message (${submitResult.response.status})`);
  }

  return {
    sessionId: createResult.json.session.id,
    sessionName: trimString(createResult.json.session.name || sessionPayload.name),
    remotelabRunId: submitResult.json.run.id,
    requestId,
    externalTriggerId,
  };
}

function pruneHandledRuns(handledRuns) {
  const entries = Object.entries(handledRuns || {});
  if (entries.length <= MAX_HANDLED_RUNS) return handledRuns || {};
  entries.sort((left, right) => Date.parse(right[1]?.updatedAt || right[1]?.triggeredAt || '') - Date.parse(left[1]?.updatedAt || left[1]?.triggeredAt || ''));
  return Object.fromEntries(entries.slice(0, MAX_HANDLED_RUNS));
}

async function collectIncidents(options, candidates, snapshotDir) {
  await ensureDir(snapshotDir);
  return Promise.all(candidates.map(async (run) => {
    const jobs = await loadRunJobs(options.repo, run.id);
    const failedJobs = normalizeFailedJobs(jobs);
    const failedLog = truncateLogText(await loadFailedLog(options.repo, run.id), options.maxLogLines, options.maxLogChars);
    const commit = await loadCommit(options.repo, run.head_sha);
    const snapshotFile = join(snapshotDir, buildSnapshotFilename(run));
    await writeFile(snapshotFile, renderSnapshot({
      repo: options.repo,
      sessionFolder: options.sessionFolder,
      run,
      commit,
      failedJobs,
      failedLog,
    }));
    return {
      run,
      commit,
      failedJobs,
      failedLog,
      snapshotFile,
    };
  }));
}

function defaultState() {
  return {
    repo: '',
    initializedAt: '',
    lastPollAt: '',
    handledRuns: {},
  };
}

function buildOutputSummary({ options, latestRuns, skipped, triggered, warnings }) {
  return {
    repo: options.repo,
    branches: options.branches,
    events: options.events,
    workflows: options.workflows,
    dryRun: options.dryRun,
    latestRunGroups: latestRuns.map((run) => ({
      githubRunId: run.id,
      branch: trimString(run.head_branch),
      workflow: workflowLabel(run),
      event: trimString(run.event),
      status: trimString(run.status),
      conclusion: trimString(run.conclusion),
      url: trimString(run.html_url),
    })),
    skipped,
    triggered,
    warnings,
  };
}

function printSummary(summary, asJson = false) {
  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(`repo: ${summary.repo}`);
  console.log(`latest groups: ${summary.latestRunGroups.length}`);
  console.log(`triggered: ${summary.triggered.length}`);
  for (const item of summary.triggered) {
    console.log(`- run ${item.githubRunId} -> session ${item.sessionId} (${item.branch} / ${item.workflow})`);
  }
  for (const item of summary.skipped) {
    console.log(`- skip run ${item.githubRunId} (${item.branch} / ${item.workflow}): ${item.reason}`);
  }
  for (const warning of summary.warnings) {
    console.log(`warning: ${warning}`);
  }
}

export async function runGithubCiAutoRepair(argv = []) {
  const options = parseArgs(argv);
  const stateFile = options.stateFile || defaultStateFile(options.repo);
  const snapshotDir = options.snapshotDir || defaultSnapshotDir(options.repo);
  const state = {
    ...defaultState(),
    ...await readJson(stateFile, defaultState()),
  };
  const warnings = [];
  const allRuns = [];

  for (const branch of options.branches) {
    try {
      const runs = await listWorkflowRuns(options.repo, branch, options.limit);
      allRuns.push(...runs);
    } catch (error) {
      warnings.push(`failed to load runs for ${branch}: ${error.message || String(error)}`);
    }
  }

  const { latestRuns, candidates, skipped } = selectLatestFailureCandidates(allRuns, options, state, Date.now());
  const incidents = await collectIncidents(options, candidates, snapshotDir);
  const runtime = {
    baseUrl: options.chatBaseUrl,
    authToken: '',
    authCookie: '',
  };

  const triggered = [];
  for (const incident of incidents) {
    if (options.dryRun) {
      triggered.push({
        githubRunId: incident.run.id,
        branch: trimString(incident.run.head_branch),
        workflow: workflowLabel(incident.run),
        url: trimString(incident.run.html_url),
        snapshotFile: incident.snapshotFile,
        dryRun: true,
      });
      continue;
    }

    const sessionResult = await triggerRepairSession(options, runtime, incident);
    const triggeredAt = nowIso();
    state.handledRuns[String(incident.run.id)] = {
      githubRunId: incident.run.id,
      branch: trimString(incident.run.head_branch),
      workflow: workflowLabel(incident.run),
      headSha: trimString(incident.run.head_sha),
      url: trimString(incident.run.html_url),
      sessionId: sessionResult.sessionId,
      sessionName: sessionResult.sessionName,
      remotelabRunId: sessionResult.remotelabRunId,
      requestId: sessionResult.requestId,
      snapshotFile: incident.snapshotFile,
      triggeredAt,
      updatedAt: triggeredAt,
    };
    triggered.push({
      githubRunId: incident.run.id,
      branch: trimString(incident.run.head_branch),
      workflow: workflowLabel(incident.run),
      url: trimString(incident.run.html_url),
      sessionId: sessionResult.sessionId,
      remotelabRunId: sessionResult.remotelabRunId,
      snapshotFile: incident.snapshotFile,
    });
  }

  if (!options.dryRun) {
    state.repo = options.repo;
    if (!trimString(state.initializedAt)) state.initializedAt = nowIso();
    state.lastPollAt = nowIso();
    state.handledRuns = pruneHandledRuns(state.handledRuns);
    await writeJson(stateFile, state);
  }

  const summary = buildOutputSummary({
    options,
    latestRuns,
    skipped,
    triggered,
    warnings,
  });
  printSummary(summary, options.json);
  return summary;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  runGithubCiAutoRepair(process.argv.slice(2)).catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}
