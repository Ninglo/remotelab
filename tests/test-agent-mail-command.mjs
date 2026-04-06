import assert from 'assert/strict';
import { mkdtempSync, writeFileSync } from 'fs';
import http from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

const repoRoot = process.cwd();
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-agent-mail-command-'));
process.env.HOME = tempHome;

const mailboxRoot = join(tempHome, '.config', 'remotelab', 'agent-mailbox');

const { initializeMailbox, loadOutboundConfig, saveOutboundConfig } = await import('../lib/agent-mailbox.mjs');
const { runAgentMailCommand } = await import('../lib/agent-mail-command.mjs');
const { sendOutboundEmail } = await import('../lib/agent-mail-outbound.mjs');

const requests = [];
const sockets = new Set();
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) {
    body += chunk.toString();
  }
  requests.push({
    method: req.method,
    url: req.url,
    headers: req.headers,
    body,
  });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ id: 'msg_cli_123', message: 'queued' }));
});

server.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

try {
  await initializeMailbox({
    rootDir: mailboxRoot,
    name: 'Rowan',
    localPart: 'rowan',
    domain: 'example.com',
    allowEmails: ['owner@example.com'],
  });

  const defaultOutbound = await loadOutboundConfig(mailboxRoot);
  assert.equal(defaultOutbound.provider, 'resend_api');
  assert.equal(defaultOutbound.apiKeyEnv, 'RESEND_API_KEY');
  assert.equal(defaultOutbound.apiBaseUrl, 'https://api.resend.com');

  let statusStdout = '';
  const statusCode = await runAgentMailCommand([
    'outbound',
    'status',
    '--root', mailboxRoot,
  ], {
    stdout: {
      write(chunk) {
        statusStdout += String(chunk);
      },
    },
  });
  assert.equal(statusCode, 0);
  const status = JSON.parse(statusStdout);
  assert.equal(status.provider, 'resend_api');
  assert.equal(status.configured, false);
  assert.deepEqual(status.missing, ['API key (RESEND_API_KEY)']);
  assert.match(status.setupHint, /configure-resend-api/);

  await assert.rejects(
    () => runAgentMailCommand([
      'send',
      '--root', mailboxRoot,
      '--to', 'recipient@example.com',
      '--subject', 'Missing resend config',
      '--text', 'This should fail with a setup hint.',
    ]),
    /Resend outbound email is not configured/,
  );

  const fallbackAppleMailMessages = [];
  const fallbackResult = await sendOutboundEmail({
    to: ['fallback@example.com'],
    from: 'rowan@example.com',
    subject: 'Fallback default route',
    text: 'Use fallback when resend is unavailable.',
  }, {
    provider: 'resend_api',
    fallback: {
      provider: 'apple_mail',
      account: 'Rowan Mail',
    },
  }, {
    sendAppleMailMessageImpl: async (message) => {
      fallbackAppleMailMessages.push(message);
      return { sender: 'rowan@example.com' };
    },
  });
  assert.equal(fallbackResult.provider, 'apple_mail');
  assert.equal(fallbackResult.requestedProvider, 'resend_api');
  assert.equal(fallbackResult.fallbackFromProvider, 'resend_api');
  assert.equal(fallbackResult.fallbackReason, 'provider_unconfigured');
  assert.equal(fallbackAppleMailMessages.length, 1);
  assert.equal(fallbackAppleMailMessages[0].account, 'Rowan Mail');
  assert.deepEqual(fallbackAppleMailMessages[0].to, ['fallback@example.com']);
  assert.equal(fallbackAppleMailMessages[0].subject, 'Fallback default route');

  const previousResendApiKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = 'resend-api-secret';
  await saveOutboundConfig(mailboxRoot, {
    apiBaseUrl: `http://127.0.0.1:${port}`,
  });

  const draftPath = join(tempHome, 'draft.txt');
  writeFileSync(draftPath, 'Hello from the new mail command.\n', 'utf8');

  let sendStdout = '';
  const sendCode = await runAgentMailCommand([
    'send',
    '--root', mailboxRoot,
    '--to', 'recipient@example.com',
    '--subject', 'Mail command test',
    '--text-file', draftPath,
    '--json',
  ], {
    stdout: {
      write(chunk) {
        sendStdout += String(chunk);
      },
    },
  });

  assert.equal(sendCode, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].url, '/emails');
  assert.equal(requests[0].headers.authorization, 'Bearer resend-api-secret');
  assert.deepEqual(JSON.parse(requests[0].body), {
    from: 'rowan@example.com',
    to: 'recipient@example.com',
    subject: 'Mail command test',
    text: 'Hello from the new mail command.',
  });

  const output = JSON.parse(sendStdout);
  assert.equal(output.provider, 'resend_api');
  assert.equal(output.to.length, 1);
  assert.equal(output.to[0], 'recipient@example.com');
  assert.equal(output.from, 'rowan@example.com');
  assert.equal(output.subject, 'Mail command test');
  assert.equal(output.responseId, 'msg_cli_123');
  assert.equal(output.responseMessage, 'queued');

  await saveOutboundConfig(mailboxRoot, {
    provider: 'cloudflare_worker',
    workerBaseUrl: `http://127.0.0.1:${port}`,
    workerToken: 'cloudflare-worker-secret',
    from: 'existing@example.com',
  });

  let configStdout = '';
  const configCode = await runAgentMailCommand([
    'outbound',
    'configure-resend-api',
    '--root', mailboxRoot,
    '--from', 'agent@example.com',
    '--api-key-env', 'RESEND_API_KEY',
  ], {
    stdout: {
      write(chunk) {
        configStdout += String(chunk);
      },
    },
  });
  assert.equal(configCode, 0);
  assert.match(configStdout, /resend_api/);
  assert.match(configStdout, /RESEND_API_KEY/);

  if (previousResendApiKey === undefined) {
    delete process.env.RESEND_API_KEY;
  } else {
    process.env.RESEND_API_KEY = previousResendApiKey;
  }

  const cliHelpResult = spawnSync(process.execPath, ['cli.js', 'mail', '--help'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: tempHome,
    },
    encoding: 'utf8',
  });
  assert.equal(cliHelpResult.status, 0, cliHelpResult.stderr);
  assert.match(cliHelpResult.stdout, /remotelab mail send/);
} finally {
  for (const socket of sockets) {
    socket.destroy();
  }
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

console.log('test-agent-mail-command: ok');
