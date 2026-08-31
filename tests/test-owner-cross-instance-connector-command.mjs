#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tempRoot = await mkdtemp(join(tmpdir(), 'remotelab-owner-instance-connector-'));
const ownerRoot = join(tempRoot, 'owner');
const ownerConfigDir = join(ownerRoot, 'config');
const targetRoot = join(tempRoot, 'trial8');
const targetConfigDir = join(targetRoot, 'config');
await mkdir(ownerConfigDir, { recursive: true });
await mkdir(targetConfigDir, { recursive: true });
await mkdir(join(targetRoot, 'memory'), { recursive: true });
await mkdir(join(targetRoot, 'workspace'), { recursive: true });
await mkdir(join(targetRoot, 'tmp'), { recursive: true });

process.env.HOME = ownerRoot;
process.env.REMOTELAB_INSTANCE_ROOT = ownerRoot;
process.env.REMOTELAB_CONFIG_DIR = ownerConfigDir;
process.env.REMOTELAB_MEMORY_DIR = join(ownerRoot, 'memory');
process.env.REMOTELAB_WORK_ROOT_DIR = join(ownerRoot, 'workspace');
process.env.REMOTELAB_OWNER_CONFIG_DIR = ownerConfigDir;
process.env.REMOTELAB_SESSION_ID = 'owner-admin-session';

const deliveries = [];
const server = http.createServer((req, res) => {
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    if (req.headers.authorization !== 'Bearer target-token') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'forbidden' }));
      return;
    }
    deliveries.push(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      result: {
        connectorId: 'mock',
        deliveryState: 'delivered',
        externalId: 'mock-message-1',
      },
    }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address === 'object');

await writeFile(join(ownerConfigDir, 'guest-instances.json'), `${JSON.stringify([{
  name: 'trial8',
  port: 7769,
  instanceRoot: targetRoot,
  configDir: targetConfigDir,
  memoryDir: join(targetRoot, 'memory'),
  localBaseUrl: 'http://127.0.0.1:7769',
}], null, 2)}\n`, 'utf8');
await writeFile(join(targetConfigDir, 'connector-skill-registry.json'), `${JSON.stringify({
  mock: {
    registrations: {
      default: {
        sourceRouteId: 'default',
        skillUrl: `http://127.0.0.1:${address.port}/skill`,
        token: 'target-token',
        skills: [{
          name: 'send_text',
          description: 'Send mock text',
          schema: { text: { type: 'string', required: true } },
        }],
        updatedAt: new Date().toISOString(),
      },
    },
  },
}, null, 2)}\n`, 'utf8');

try {
  const { runOwnerInstanceConnectorCommand } = await import('../lib/owner-instance-connector-command.mjs');
  const { runConnectorCommand } = await import('../lib/connector-command.mjs');

  const direct = await runOwnerInstanceConnectorCommand('trial8', [
    'call',
    'mock:send_text',
    '--text', 'Remember to drink water',
    '--json',
  ], { env: process.env });
  assert.equal(direct.exitCode, 0);
  assert.equal(direct.targetInstance, 'trial8');
  assert.equal(JSON.parse(direct.stdout).result.externalId, 'mock-message-1');
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].instanceId, 'trial8');
  assert.equal(deliveries[0].parameters.text, 'Remember to drink water');
  assert.equal(deliveries[0].sessionId, '', 'owner session identity must not leak into the guest call');

  const auditLines = (await readFile(
    join(ownerConfigDir, 'admin-audit', 'connector-actions.jsonl'),
    'utf8',
  )).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(auditLines.length, 2);
  assert.equal(auditLines[0].type, 'admin_connector_action_started');
  assert.equal(auditLines[1].type, 'admin_connector_action_completed');
  assert.equal(auditLines[1].success, true);
  assert.equal(auditLines[1].targetInstance, 'trial8');
  assert.equal(auditLines[1].toolName, 'mock:send_text');
  assert.equal(JSON.stringify(auditLines).includes('Remember to drink water'), false, 'audit must not retain message content');
  assert.equal(JSON.stringify(auditLines).includes('target-token'), false, 'audit must not retain connector tokens');

  let delegatedCall = null;
  let stdout = '';
  const delegatedExit = await runConnectorCommand([
    'call',
    'mock:send_text',
    '--instance', 'trial8',
    '--text', 'Hello',
    '--json',
  ], {
    stdout: { write(chunk) { stdout += String(chunk); } },
    runOwnerInstanceConnectorCommand: async (instanceName, args) => {
      delegatedCall = { instanceName, args };
      return { exitCode: 0, stdout: '{"success":true}\n', stderr: '' };
    },
  });
  assert.equal(delegatedExit, 0);
  assert.equal(stdout, '{"success":true}\n');
  assert.equal(delegatedCall.instanceName, 'trial8');
  assert.deepEqual(delegatedCall.args, [
    'call',
    'mock:send_text',
    '--text', 'Hello',
    '--json',
  ], 'delegated guest call must not recursively retain --instance');

  await assert.rejects(
    () => runOwnerInstanceConnectorCommand('missing', ['list', '--json'], { env: process.env }),
    /Managed guest instance not found/,
  );

  const guestResult = await new Promise((resolve) => {
    execFileCallback(process.execPath, [join(repoRoot, 'cli.js'), 'connector', 'list', '--instance', 'trial8', '--json'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: targetRoot,
        REMOTELAB_INSTANCE_ROOT: targetRoot,
        REMOTELAB_CONFIG_DIR: targetConfigDir,
        REMOTELAB_MEMORY_DIR: join(targetRoot, 'memory'),
        REMOTELAB_WORK_ROOT_DIR: join(targetRoot, 'workspace'),
      },
      encoding: 'utf8',
    }, (error, childStdout = '', childStderr = '') => {
      resolve({ error, stdout: childStdout, stderr: childStderr });
    });
  });
  assert.ok(guestResult.error, 'guest cross-instance call must fail');
  assert.match(guestResult.stderr, /owner-only/);

  console.log('test-owner-cross-instance-connector-command: ok');
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(tempRoot, { recursive: true, force: true });
}
