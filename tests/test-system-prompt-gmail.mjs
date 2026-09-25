#!/usr/bin/env node
import assert from 'assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'remotelab-system-prompt-gmail-'));
process.env.HOME = tempHome;
process.env.REMOTELAB_INSTANCE_ROOT = path.join(tempHome, 'instance-data');
process.env.REMOTELAB_MEMORY_DIR = path.join(tempHome, 'instance-data', 'memory');
process.env.REMOTELAB_WORK_ROOT_DIR = path.join(tempHome, 'instance-data', 'workspace');
process.env.REMOTELAB_PUBLIC_BASE_URL = 'https://trial23.example.com';
process.env.REMOTELAB_CLOUDFLARE_EMAIL_WORKER_TOKEN = 'test-worker-token';
await fs.mkdir(path.join(tempHome, 'instance-data', 'config', 'gmail-connector'), { recursive: true });
await fs.writeFile(
  path.join(tempHome, 'instance-data', 'config', 'gmail-connector', 'google-oauth-client.json'),
  JSON.stringify({
    installed: {
      client_id: 'test-client-id',
      client_secret: 'test-client-secret',
      redirect_uris: ['https://trial23.example.com/api/connectors/gmail/google/callback'],
    },
  }),
  'utf8',
);
await fs.mkdir(path.join(tempHome, 'instance-data', 'config', 'agent-mailbox'), { recursive: true });
await fs.writeFile(
  path.join(tempHome, 'instance-data', 'config', 'agent-mailbox', 'identity.json'),
  JSON.stringify({ name: 'Rowan', address: 'rowan@example.com', status: 'ready' }),
  'utf8',
);
await fs.writeFile(
  path.join(tempHome, 'instance-data', 'config', 'agent-mailbox', 'outbound.json'),
  JSON.stringify({
    provider: 'cloudflare_worker',
    from: 'rowan@example.com',
    workerBaseUrl: 'https://mail.example.com',
    workerTokenEnv: 'REMOTELAB_CLOUDFLARE_EMAIL_WORKER_TOKEN',
  }),
  'utf8',
);

const { ensureEmailConnectorBinding } = await import('../lib/connector-bindings.mjs');
await ensureEmailConnectorBinding({
  rootDir: path.join(tempHome, 'instance-data', 'config', 'agent-mailbox'),
});

const { buildSystemContext } = await import('../chat/system-prompt.mjs');
const context = await buildSystemContext({ sessionId: 'session-test-gmail' });

assert.doesNotMatch(context, /rowan@example\.com/);
assert.doesNotMatch(context, /### Agent Mailbox|### Gmail/);
assert.match(context, /remotelab gmail status --json/);
assert.match(context, /remotelab gmail --help/);
assert.match(context, /remotelab mail --help/);
assert.match(context, /User Gmail and Agent Mailbox/);
assert.doesNotMatch(context, /literal `\\n`|\/connectors\/gmail/);

console.log('test-system-prompt-gmail: ok');
