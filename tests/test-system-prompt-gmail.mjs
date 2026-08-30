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

const { buildSystemContext } = await import('../chat/system-prompt.mjs');
const context = await buildSystemContext({ sessionId: 'session-test-gmail' });

assert.match(context, /### Agent Mailbox/);
assert.match(context, /Rowan <rowan@example\.com>/);
assert.match(context, /remotelab mail send/);
assert.match(context, /monitoring alerts, reminders, reports, status updates, and proactive follow-ups must use this Agent Mailbox by default/);
assert.match(context, /bound Gmail account belongs to the user; it is not the assistant's default sender/);
assert.match(context, /Never switch from the Agent Mailbox to the user's Gmail merely because delivery from the Agent Mailbox fails/);
assert.match(context, /### Gmail/);
assert.match(context, /user-owned Gmail account/);
assert.match(context, /remotelab gmail status --json/);
assert.match(context, /remotelab gmail --help/);
assert.match(context, /\/connectors\/gmail/);
assert.match(context, /Do not claim Gmail is unavailable, ask for IMAP credentials, or say there is no access until you have checked the live Gmail status/);
assert.match(context, /If Gmail status is `ready`, use the Gmail CLI for that user-mailbox task/);
assert.match(context, /A new alert, reminder, report, status update, or proactive follow-up from the assistant must use the ready Agent Mailbox above instead of Gmail/);

console.log('test-system-prompt-gmail: ok');
