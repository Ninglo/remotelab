import assert from 'assert/strict';
import { execFileSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function parseArgs(argv = []) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const nextToken = argv[index + 1];
    const value = !nextToken || nextToken.startsWith('--') ? true : nextToken;
    if (value !== true) index += 1;
    options[key] = value;
  }
  return options;
}

function readJsonCommand(command, args, { input = '' } = {}) {
  const stdout = execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    input,
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

export function remotelabApi(method, path, { body, waitRun = false, timeoutMs = 600000 } = {}) {
  const args = ['api', method, path];
  if (body !== undefined) {
    args.push('--body', JSON.stringify(body));
  }
  if (waitRun) {
    args.push('--wait-run', '--timeout-ms', String(timeoutMs));
  }
  return readJsonCommand('remotelab', args);
}

export function remotelabAgenda(args = []) {
  return readJsonCommand('remotelab', ['agenda', ...args]);
}

export function resolveSmokeAgentConfig(options = {}) {
  const tool = trimString(options.tool || process.env.REMOTELAB_SMOKE_TOOL) || 'codex';
  let model = trimString(options.model || process.env.REMOTELAB_SMOKE_MODEL);
  if (!model && tool === 'micro-agent') model = 'sonnet';
  const effort = trimString(options.effort || process.env.REMOTELAB_SMOKE_EFFORT) || 'low';
  const thinking = options.thinking === true || process.env.REMOTELAB_SMOKE_THINKING === '1';
  return { tool, model, effort, thinking };
}

export function ensureSmokeAgentAvailable({ tool, model = '' } = {}) {
  const tools = remotelabApi('GET', '/api/tools').tools || [];
  const selected = tools.find((entry) => trimString(entry.id) === trimString(tool));
  assert.ok(selected, `Smoke tool not found: ${tool}`);
  assert.equal(selected.available, true, `Smoke tool is not available: ${tool}`);

  if (model) {
    const supportedModels = Array.isArray(selected.models) ? selected.models.map((entry) => trimString(entry.id)) : [];
    if (supportedModels.length > 0) {
      assert.ok(
        supportedModels.includes(model),
        `Smoke model ${model} is not supported by tool ${tool}; available: ${supportedModels.join(', ')}`,
      );
    }
  }

  return selected;
}

export function createSmokeSession({
  name = 'agent smoke',
  group = 'Integration Tests',
  description = 'Live agent smoke test',
  tool = 'micro-agent',
  folder = repoRoot,
} = {}) {
  const payload = {
    folder,
    tool,
    name,
    group,
    description,
  };
  return remotelabApi('POST', '/api/sessions', { body: payload }).session;
}

export function submitSmokeMessage(sessionId, {
  text,
  tool,
  model = '',
  effort = '',
  thinking = false,
  timeoutMs = 600000,
} = {}) {
  const payload = {
    text,
    tool,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(thinking ? { thinking } : {}),
  };
  return remotelabApi('POST', `/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
    body: payload,
    waitRun: true,
    timeoutMs,
  });
}

export function loadSessionEvents(sessionId, { filter = 'all' } = {}) {
  return remotelabApi('GET', `/api/sessions/${encodeURIComponent(sessionId)}/events?filter=${encodeURIComponent(filter)}`);
}

export function archiveSession(sessionId) {
  return remotelabApi('PATCH', `/api/sessions/${encodeURIComponent(sessionId)}`, {
    body: { archived: true },
  });
}

export function findAgendaEventByTitle(title) {
  const events = remotelabAgenda(['list', '--json']).events || [];
  return events.find((event) => trimString(event.summary || event.title) === trimString(title)) || null;
}

export function getAgendaEvent(eventId) {
  return remotelabAgenda(['get', eventId, '--json']).event || null;
}

export function deleteAgendaEvent(eventId) {
  return remotelabAgenda(['delete', eventId, '--json']);
}

export function extractAgendaEventIdFromEvents(events = [], title = '') {
  const toolUse = events.find((event) => event.type === 'tool_use'
    && trimString(event.toolName) === 'bash'
    && /remotelab agenda add /.test(trimString(event.toolInput))
    && trimString(event.toolInput).includes(trimString(title)));
  const toolResult = events.find((event) => event.type === 'tool_result'
    && trimString(event.toolName) === 'bash'
    && /(^|\n)id:\s*(.+)/.test(trimString(event.output)));

  const idMatch = trimString(toolResult?.output || '').match(/(^|\n)id:\s*([^\n]+)/);
  return {
    toolUse: toolUse || null,
    toolResult: toolResult || null,
    eventId: idMatch ? trimString(idMatch[2]) : '',
  };
}

export function buildUniqueTitle(prefix = 'RL smoke') {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${prefix} ${stamp}`;
}
