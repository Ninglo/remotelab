#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer } from 'http';

import { runMailboxIngressSelfCheck } from '../lib/mailbox-ingress-self-check.mjs';

function startJsonServer(payload, statusCode = 200) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const tempRoot = mkdtempSync(join(tmpdir(), 'remotelab-mailbox-ingress-self-check-'));
const configDir = join(tempRoot, 'config');
const mailboxRoot = join(configDir, 'agent-mailbox');
const cloudflaredDir = join(tempRoot, 'cloudflared');
const cloudflaredConfigPath = join(cloudflaredDir, 'agent-mailbox-config.yml');
const credentialsFile = join(cloudflaredDir, 'agent-mailbox.json');
const bridgeEventsFile = join(mailboxRoot, 'bridge-events.jsonl');

await import('fs/promises').then(({ mkdir }) => Promise.all([
  mkdir(mailboxRoot, { recursive: true }),
  mkdir(cloudflaredDir, { recursive: true }),
]));

writeFileSync(credentialsFile, '{}\n', 'utf8');
writeFileSync(join(configDir, 'guest-instances.json'), JSON.stringify([
  {
    name: 'miglab',
    publicBaseUrl: 'https://factory.example.com',
    mailboxAddress: 'miglab@example.com',
  },
], null, 2), 'utf8');
writeFileSync(join(mailboxRoot, 'bridge.json'), JSON.stringify({
  publicWebhook: 'https://mailhook.example.com/cloudflare-email/webhook',
}, null, 2), 'utf8');
writeFileSync(cloudflaredConfigPath, [
  'tunnel: tunnel-id',
  `credentials-file: ${credentialsFile}`,
  'ingress:',
  '  - hostname: mailhook.example.com',
  '    service: http://127.0.0.1:7694',
  '  - service: http_status:404',
  '',
].join('\n'), 'utf8');
writeFileSync(bridgeEventsFile, [
  JSON.stringify({
    event: 'accepted_cloudflare_email_webhook',
    createdAt: '2026-04-12T05:17:37.965Z',
    routedInstance: 'miglab',
    routeSource: 'instance_mailbox_address',
    mailboxItem: { to: 'miglab@example.com' },
  }),
].join('\n'), 'utf8');

const localServer = await startJsonServer({ ok: true, service: 'local-bridge' });
const publicServer = await startJsonServer({ ok: true, service: 'public-bridge' });
const localPort = localServer.address().port;
const publicPort = publicServer.address().port;

const readyResult = await runMailboxIngressSelfCheck({
  configDir,
  cloudflaredConfigPath,
  localHealthUrl: `http://127.0.0.1:${localPort}/healthz`,
  publicHealthUrl: `http://127.0.0.1:${publicPort}/healthz`,
  serviceStates: {
    'cloudflared-agent-mailbox': 'active',
    'remotelab-agent-mail-bridge': 'active',
    'remotelab-agent-mail-worker': 'active',
  },
  now: new Date('2026-04-12T06:00:00Z'),
});
assert.equal(readyResult.overallStatus, 'ready');
assert.equal(readyResult.checks.find((check) => check.id === 'mail-runtime-registry-drift')?.status, 'pass');

writeFileSync(join(configDir, 'guest-instances.json'), '[]\n', 'utf8');
const driftResult = await runMailboxIngressSelfCheck({
  configDir,
  cloudflaredConfigPath,
  localHealthUrl: `http://127.0.0.1:${localPort}/healthz`,
  publicHealthUrl: `http://127.0.0.1:${publicPort}/healthz`,
  serviceStates: {
    'cloudflared-agent-mailbox': 'active',
    'remotelab-agent-mail-bridge': 'active',
    'remotelab-agent-mail-worker': 'active',
  },
  now: new Date('2026-04-12T06:00:00Z'),
});
assert.equal(driftResult.overallStatus, 'degraded');
assert.equal(driftResult.checks.find((check) => check.id === 'mail-runtime-registry-drift')?.status, 'warn');

writeFileSync(cloudflaredConfigPath, [
  'tunnel: tunnel-id',
  `credentials-file: ${join(cloudflaredDir, 'missing.json')}`,
  'ingress:',
  '  - hostname: mailhook.example.com',
  '    service: http://127.0.0.1:7694',
  '  - service: http_status:404',
  '',
].join('\n'), 'utf8');
publicServer.closeAllConnections?.();
await new Promise((resolve) => publicServer.close(resolve));

const blockedResult = await runMailboxIngressSelfCheck({
  configDir,
  cloudflaredConfigPath,
  localHealthUrl: `http://127.0.0.1:${localPort}/healthz`,
  publicHealthUrl: `http://127.0.0.1:9/healthz`,
  serviceStates: {
    'cloudflared-agent-mailbox': 'inactive',
    'remotelab-agent-mail-bridge': 'active',
    'remotelab-agent-mail-worker': 'active',
  },
  now: new Date('2026-04-12T06:00:00Z'),
});
assert.equal(blockedResult.overallStatus, 'blocked');
assert.equal(blockedResult.checks.find((check) => check.id === 'mailhook-tunnel-credentials')?.status, 'fail');
assert.equal(blockedResult.checks.find((check) => check.id === 'mailhook-public-health')?.status, 'fail');

localServer.closeAllConnections?.();
await new Promise((resolve) => localServer.close(resolve));
rmSync(tempRoot, { recursive: true, force: true });
console.log('test-mailbox-ingress-self-check: ok');
