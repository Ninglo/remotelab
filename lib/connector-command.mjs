import { CONFIG_DIR, INSTANCE_NAME } from './config.mjs';
import {
  executeConnectorSkill,
  getAllToolDefinitions,
  initSkillRegistry,
  isConnectorSkillReady,
} from './connector-skill-registry.mjs';
import { createRemoteLabHttpClient } from './remotelab-http-client.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function optionNameToParameter(name) {
  return trimString(name).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function coerceOptionValue(value, parameter = {}) {
  const type = trimString(parameter?.type).toLowerCase();
  const normalized = typeof value === 'string' ? value.trim() : value;
  if (type === 'number' || type === 'integer') {
    const number = Number(normalized);
    return Number.isFinite(number) ? number : value;
  }
  if (type === 'boolean') {
    if (normalized === true || normalized === 'true') return true;
    if (normalized === false || normalized === 'false') return false;
  }
  return value;
}

function parseArgs(argv = []) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      options[name] = true;
      continue;
    }
    options[name] = next;
    index += 1;
  }
  return { positional, options };
}

function printHelp(stdout) {
  stdout.write(`Usage:
  remotelab connector list [--json]
  remotelab connector call <channel:skill> [--parameter value ...] [--json]

Example:
  remotelab connector call wechat:send_text --text "Reminder text" --json

Connector calls are instance-scoped transport actions. Provider credentials
remain inside the registered connector process and are never printed by this
command. General provider APIs such as Feishu Docs, Wiki, Base, Sheets, and
Drive belong to the instance runtime and its native CLI tools, not Connector
actions. Calls made inside a connector-backed session automatically use that
session's source route.
`);
}

function parseToolChannel(toolName) {
  const normalized = trimString(toolName);
  const colonIndex = normalized.indexOf(':');
  return colonIndex > 0 ? normalized.slice(0, colonIndex).toLowerCase() : '';
}

async function resolveSessionSourceRoute(toolName, sessionId, requestId) {
  const channel = parseToolChannel(toolName);
  if (!channel || !sessionId) return '';
  const query = new URLSearchParams();
  if (requestId) query.set('requestId', requestId);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  try {
    const client = createRemoteLabHttpClient();
    const result = await client.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/source-context${suffix}`,
    );
    if (!result.response.ok) return '';
    const sourceContext = result.json?.sourceContext || {};
    for (const candidate of [sourceContext.message, sourceContext.session]) {
      const connector = trimString(candidate?.connector).toLowerCase();
      const sourceRouteId = trimString(candidate?.sourceRouteId);
      if (connector === channel && sourceRouteId) return sourceRouteId;
    }
  } catch {
  }
  return '';
}

function writePayload(stdout, payload, json) {
  stdout.write(`${JSON.stringify(payload, null, json ? 2 : 0)}\n`);
}

export async function runConnectorCommand(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  const { positional, options } = parseArgs(argv);
  const command = trimString(positional[0]).toLowerCase();
  const json = options.json === true || trimString(options.json).toLowerCase() === 'true';
  if (!command || command === 'help' || options.help === true) {
    printHelp(stdout);
    return 0;
  }

  await initSkillRegistry(CONFIG_DIR);
  if (command === 'list') {
    const tools = await getAllToolDefinitions();
    const readiness = await Promise.all(tools.map(async (tool) => ({
      ...tool,
      ready: await isConnectorSkillReady(tool.name),
    })));
    writePayload(stdout, { tools: readiness }, json);
    return 0;
  }

  if (command !== 'call') {
    throw new Error(`Unknown connector command: ${command}`);
  }
  const toolName = trimString(positional[1]);
  if (!toolName) throw new Error('connector call requires <channel:skill>');
  const toolDefinition = (await getAllToolDefinitions())
    .find((tool) => trimString(tool?.name) === toolName);
  const parameterDefinitions = toolDefinition?.parameters || {};

  const reserved = new Set(['json', 'help', 'session-id', 'instance-id', 'source-route-id']);
  const parameters = {};
  for (const [name, value] of Object.entries(options)) {
    if (reserved.has(name)) continue;
    const parameterName = optionNameToParameter(name);
    parameters[parameterName] = coerceOptionValue(value, parameterDefinitions[parameterName]);
  }
  const sessionId = trimString(options['session-id']) || trimString(process.env.REMOTELAB_SESSION_ID);
  const sessionSourceRouteId = await resolveSessionSourceRoute(
    toolName,
    sessionId,
    trimString(process.env.REMOTELAB_REQUEST_ID),
  );
  const sourceRouteId = sessionSourceRouteId || trimString(options['source-route-id']);
  const result = await executeConnectorSkill(toolName, parameters, {
    instanceId: trimString(options['instance-id']) || INSTANCE_NAME || 'owner',
    sessionId,
    sourceRouteId,
  });
  writePayload(stdout, result, json);
  return result?.success === true ? 0 : 1;
}
