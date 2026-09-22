import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import http from 'http';
import { tmpdir } from 'os';
import { join } from 'path';

const tempRoot = mkdtempSync(join(tmpdir(), 'remotelab-api-command-'));
const homeDir = join(tempRoot, 'home');
mkdirSync(join(homeDir, '.config', 'remotelab'), { recursive: true });
writeFileSync(join(homeDir, '.config', 'remotelab', 'auth.json'), `${JSON.stringify({
  version: 2,
  serviceToken: 'owner-token',
  primaryPersonId: 'person_owner',
  people: [{ id: 'person_owner', name: 'Owner', credentials: [], identities: [] }],
})}\n`, 'utf8');
process.env.HOME = homeDir;

let runPolls = 0;
let observedSourceSessionId = '';
const sockets = new Set();
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/' && url.searchParams.get('token') === 'owner-token') {
    res.writeHead(302, {
      'Set-Cookie': 'remotelab_session=owner; Path=/',
      Location: '/app',
    });
    res.end();
    return;
  }

  const cookie = req.headers.cookie || '';
  if (!cookie.includes('remotelab_session=owner')) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'forbidden' }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/tools') {
    observedSourceSessionId = String(req.headers['x-remotelab-source-session-id'] || '');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tools: [{ id: 'codex' }, { id: 'micro-agent' }] }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/sessions/sess-1/messages') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body || '{}');
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      session: { id: 'sess-1' },
      run: { id: 'run-1' },
      acceptedText: parsed.text,
    }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/runs/run-1') {
    runPolls += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      run: {
        id: 'run-1',
        state: runPolls >= 2 ? 'completed' : 'running',
      },
    }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/sessions/sess-1/events') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      events: [
        {
          seq: 1,
          type: 'message',
          role: 'assistant',
          runId: 'run-1',
          content: 'api-ok',
        },
      ],
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address && typeof address === 'object');
const baseUrl = `http://127.0.0.1:${address.port}`;

const { runRemoteLabApiCommand } = await import('../lib/remotelab-api-command.mjs');
process.env.REMOTELAB_SESSION_ID = 'source-session-from-environment';

async function runCli(args) {
  let stdout = '';
  await runRemoteLabApiCommand(args, {
    stdout: {
      write(chunk) {
        stdout += String(chunk);
      },
    },
  });
  return stdout;
}

const toolsJson = JSON.parse(await runCli(['GET', '/api/tools', '--base-url', baseUrl]));
assert.deepEqual(toolsJson.tools.map((tool) => tool.id), ['codex', 'micro-agent']);
assert.equal(observedSourceSessionId, 'source-session-from-environment');

const messageJson = JSON.parse(await runCli([
  'POST',
  '/api/sessions/sess-1/messages',
  '--base-url', baseUrl,
  '--body', '{"text":"hello from cli"}',
  '--wait-run',
  '--timeout-ms', '5000',
]));
assert.equal(messageJson.acceptedText, 'hello from cli');
assert.equal(messageJson.awaitedRun?.state, 'completed');
assert.equal(messageJson.reply, 'api-ok');
assert.equal(messageJson.sessionUrl, '/?session=sess-1&tab=sessions');

for (const socket of sockets) {
  socket.destroy();
}
server.closeAllConnections?.();
await new Promise((resolve) => server.close(resolve));

console.log('test-remotelab-api-command: ok');
