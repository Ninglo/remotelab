#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoot = await mkdtemp(join(tmpdir(), 'remotelab-connector-multi-route-'));
const configDir = join(tempRoot, 'config');
await mkdir(configDir, { recursive: true });
await writeFile(join(configDir, 'auth.json'), `${JSON.stringify({ token: 'owner-token' })}\n`, 'utf8');

process.env.HOME = tempRoot;
process.env.REMOTELAB_CONFIG_DIR = configDir;
process.env.REMOTELAB_MEMORY_DIR = join(tempRoot, 'memory');
process.env.REMOTELAB_WORK_ROOT_DIR = join(tempRoot, 'workspace');
process.env.REMOTELAB_SESSION_ID = 'session-from-bot-a';
process.env.REMOTELAB_REQUEST_ID = 'request-from-bot-a';

const sockets = new Set();
const sourceContextServer = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/' && url.searchParams.get('token') === 'owner-token') {
    res.writeHead(302, {
      'Set-Cookie': 'remotelab_session=owner; Path=/',
      Location: '/app',
    });
    res.end();
    return;
  }
  if (!String(req.headers.cookie || '').includes('remotelab_session=owner')) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'forbidden' }));
    return;
  }
  if (
    req.method === 'GET'
    && url.pathname === '/api/sessions/session-from-bot-a/source-context'
    && url.searchParams.get('requestId') === 'request-from-bot-a'
  ) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      sessionId: 'session-from-bot-a',
      sourceContext: {
        session: { connector: 'messaging', sourceRouteId: 'bot-a' },
        message: { connector: 'messaging', sourceRouteId: 'bot-a' },
        requestId: 'request-from-bot-a',
      },
    }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});
sourceContextServer.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});
await new Promise((resolve) => sourceContextServer.listen(0, '127.0.0.1', resolve));
const sourceContextAddress = sourceContextServer.address();
assert.ok(sourceContextAddress && typeof sourceContextAddress === 'object');
process.env.REMOTELAB_CHAT_BASE_URL = `http://127.0.0.1:${sourceContextAddress.port}`;

const {
  deregisterConnectorSkills,
  executeConnectorSkill,
  initSkillRegistry,
  registerConnectorSkills,
} = await import('../lib/connector-skill-registry.mjs');
const { startConnectorSkillServer } = await import('../lib/connector-skill-server.mjs');
const { runConnectorCommand } = await import('../lib/connector-command.mjs');

const transportSkill = {
  name: 'send_message',
  description: 'Send a message through the originating transport identity.',
  schema: { text: { type: 'string', required: true } },
};

async function startBotSkillServer(botId, token) {
  return startConnectorSkillServer({
    channel: 'messaging',
    token,
    skills: [transportSkill],
    onSkill: async (_skillName, body) => ({
      botId,
      text: body?.parameters?.text || '',
    }),
  });
}

const botAServer = await startBotSkillServer('bot-a', 'token-a');
const botBServer = await startBotSkillServer('bot-b', 'token-b');

try {
  await initSkillRegistry(configDir);
  await registerConnectorSkills('messaging', {
    sourceRouteId: 'bot-a',
    callback: { skillUrl: botAServer.skillUrl, token: 'token-a' },
    skills: [transportSkill],
  });
  await registerConnectorSkills('messaging', {
    sourceRouteId: 'bot-b',
    callback: { skillUrl: botBServer.skillUrl, token: 'token-b' },
    skills: [transportSkill],
  });

  const directA = await executeConnectorSkill(
    'messaging:send_message',
    { text: 'Transport message' },
    { sourceRouteId: 'bot-a' },
  );
  assert.equal(directA.success, true);
  assert.equal(directA.result.botId, 'bot-a', 'bot A calls must retain bot A credentials');

  const directB = await executeConnectorSkill(
    'messaging:send_message',
    { text: 'Transport message' },
    { sourceRouteId: 'bot-b' },
  );
  assert.equal(directB.success, true);
  assert.equal(directB.result.botId, 'bot-b', 'bot B calls must retain bot B credentials');

  const ambiguous = await executeConnectorSkill(
    'messaging:send_message',
    { text: 'Transport message' },
    {},
  );
  assert.equal(ambiguous.success, false);
  assert.equal(ambiguous.error, 'source_route_required', 'multi-Bot calls must fail closed without source identity');

  let stdout = '';
  const cliExitCode = await runConnectorCommand([
    'call',
    'messaging:send_message',
    '--text', 'Transport message',
    '--json',
  ], {
    stdout: { write(chunk) { stdout += String(chunk); } },
  });
  assert.equal(cliExitCode, 0);
  assert.equal(JSON.parse(stdout).result.botId, 'bot-a', 'CLI must route from the current RemoteLab session source');

  stdout = '';
  const overrideExitCode = await runConnectorCommand([
    'call',
    'messaging:send_message',
    '--text', 'Transport message',
    '--source-route-id', 'bot-b',
    '--json',
  ], {
    stdout: { write(chunk) { stdout += String(chunk); } },
  });
  assert.equal(overrideExitCode, 0);
  assert.equal(
    JSON.parse(stdout).result.botId,
    'bot-a',
    'an explicit route must not override the originating connector session route',
  );

  assert.equal(await deregisterConnectorSkills('messaging', {
    sourceRouteId: 'bot-b',
    skillUrl: botBServer.skillUrl,
  }), true);

  const afterBotBStops = await executeConnectorSkill(
    'messaging:send_message',
    { text: 'Transport message' },
    { sourceRouteId: 'bot-a' },
  );
  assert.equal(afterBotBStops.success, true);
  assert.equal(afterBotBStops.result.botId, 'bot-a', 'stopping bot B must not remove bot A capability');

  console.log('test-connector-multi-route-skill: ok');
} finally {
  await deregisterConnectorSkills('messaging');
  await botAServer.stop();
  await botBServer.stop();
  for (const socket of sockets) socket.destroy();
  sourceContextServer.closeAllConnections?.();
  await new Promise((resolve) => sourceContextServer.close(resolve));
  await rm(tempRoot, { recursive: true, force: true });
}
