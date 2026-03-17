import { readFile } from 'fs/promises';
import { AUTH_FILE, CHAT_PORT } from './config.mjs';
import { selectAssistantReplyEvent } from './reply-selection.mjs';

const DEFAULT_RUN_POLL_INTERVAL_MS = 1200;
const DEFAULT_RUN_POLL_TIMEOUT_MS = 10 * 60 * 1000;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveDefaultChatBaseUrl() {
  const host = trimString(process.env.CHAT_BIND_HOST || '127.0.0.1') || '127.0.0.1';
  const parsedPort = Number.parseInt(String(process.env.CHAT_PORT || ''), 10);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : CHAT_PORT;
  return `http://${host}:${port}`;
}

const DEFAULT_CHAT_BASE_URL = resolveDefaultChatBaseUrl();

function normalizeBaseUrl(value) {
  const normalized = trimString(value || DEFAULT_CHAT_BASE_URL).replace(/\/+$/, '');
  return normalized || DEFAULT_CHAT_BASE_URL;
}

function printHelp(stdout = process.stdout) {
  stdout.write(`Usage:\n  remotelab session-spawn --task "<focused task>" [options]\n\nOptions:\n  --task <text>             Required delegated task / handoff goal\n  --source-session <id>     Source session id (default: $REMOTELAB_SESSION_ID)\n  --name <text>             Optional initial child session name\n  --wait                    Wait for the child run and return its reply\n  --json                    Print machine-readable JSON\n  --base-url <url>          RemoteLab base URL (default: $REMOTELAB_CHAT_BASE_URL or local 7690)\n  --timeout-ms <ms>         Wait timeout for --wait (default: 600000)\n  --help                    Show this help\n`);
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv = []) {
  const options = {
    task: '',
    sourceSessionId: trimString(process.env.REMOTELAB_SESSION_ID),
    name: '',
    wait: false,
    json: false,
    baseUrl: trimString(process.env.REMOTELAB_CHAT_BASE_URL || DEFAULT_CHAT_BASE_URL),
    timeoutMs: DEFAULT_RUN_POLL_TIMEOUT_MS,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--task':
        options.task = argv[index + 1] || '';
        index += 1;
        break;
      case '--source-session':
        options.sourceSessionId = argv[index + 1] || '';
        index += 1;
        break;
      case '--name':
        options.name = argv[index + 1] || '';
        index += 1;
        break;
      case '--wait':
        options.wait = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--base-url':
        options.baseUrl = argv[index + 1] || '';
        index += 1;
        break;
      case '--timeout-ms':
        options.timeoutMs = parsePositiveInteger(argv[index + 1], DEFAULT_RUN_POLL_TIMEOUT_MS);
        index += 1;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.task = trimString(options.task);
  options.sourceSessionId = trimString(options.sourceSessionId);
  options.name = trimString(options.name);
  options.baseUrl = normalizeBaseUrl(options.baseUrl);
  return options;
}

async function readOwnerToken() {
  const auth = JSON.parse(await readFile(AUTH_FILE, 'utf8'));
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

function buildSessionUrl(sessionId) {
  const params = new URLSearchParams();
  if (sessionId) params.set('session', sessionId);
  params.set('tab', 'sessions');
  return `/?${params.toString()}`;
}

async function waitForRunCompletion(runtime, runId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await requestRemoteLab(runtime, `/api/runs/${runId}`);
    if (!result.response.ok || !result.json?.run) {
      throw new Error(result.json?.error || result.text || `Failed to load run ${runId}`);
    }
    if (['completed', 'failed', 'cancelled'].includes(result.json.run.state)) {
      return result.json.run;
    }
    await new Promise((resolve) => setTimeout(resolve, DEFAULT_RUN_POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out waiting for run ${runId}`);
}

async function loadAssistantReply(runtime, sessionId, runId) {
  const eventsResult = await requestRemoteLab(runtime, `/api/sessions/${sessionId}/events`);
  if (!eventsResult.response.ok || !Array.isArray(eventsResult.json?.events)) {
    throw new Error(eventsResult.json?.error || eventsResult.text || `Failed to load session events for ${sessionId}`);
  }

  const selected = await selectAssistantReplyEvent(eventsResult.json.events, {
    match: (event) => runId && event.runId === runId,
    hydrate: async (event) => {
      const bodyResult = await requestRemoteLab(runtime, `/api/sessions/${sessionId}/events/${event.seq}/body`);
      if (!bodyResult.response.ok || bodyResult.json?.body?.value === undefined) {
        return event;
      }
      return {
        ...event,
        content: bodyResult.json.body.value,
        bodyLoaded: true,
      };
    },
  });
  return trimString(selected?.content || '');
}

function writeResult(result, options = {}, stdout = process.stdout) {
  if (options.json) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const lines = [
    `sessionId: ${result.sessionId || ''}`,
    `runId: ${result.runId || ''}`,
    `sessionUrl: ${result.sessionUrl || ''}`,
  ];
  if (result.reply) {
    lines.push('', result.reply);
  }
  stdout.write(`${lines.join('\n')}\n`);
}

export async function runSessionSpawnCommand(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const options = parseArgs(argv);
  if (options.help) {
    printHelp(stdout);
    return 0;
  }
  if (!options.task) {
    throw new Error('--task is required');
  }
  if (!options.sourceSessionId) {
    throw new Error('No source session id provided. Pass --source-session or set REMOTELAB_SESSION_ID.');
  }

  const runtime = {
    baseUrl: options.baseUrl,
    authToken: '',
    authCookie: '',
  };

  const result = await requestRemoteLab(runtime, `/api/sessions/${encodeURIComponent(options.sourceSessionId)}/delegate`, {
    method: 'POST',
    body: {
      task: options.task,
      ...(options.name ? { name: options.name } : {}),
    },
  });
  if (!result.response.ok || !result.json?.session?.id || !result.json?.run?.id) {
    throw new Error(result.json?.error || result.text || `Failed to spawn session (${result.response.status})`);
  }

  const output = {
    sourceSessionId: options.sourceSessionId,
    task: options.task,
    sessionId: result.json.session.id,
    sessionName: trimString(result.json.session.name || ''),
    runId: result.json.run.id,
    sessionUrl: buildSessionUrl(result.json.session.id),
  };

  if (options.wait) {
    const run = await waitForRunCompletion(runtime, result.json.run.id, options.timeoutMs);
    output.state = run.state;
    output.reply = await loadAssistantReply(runtime, result.json.session.id, result.json.run.id);
    if (run.state !== 'completed') {
      writeResult(output, options, stdout);
      stderr.write(`Child session run finished in state ${run.state}.\n`);
      return 1;
    }
  }

  writeResult(output, options, stdout);
  return 0;
}
