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

const { buildSystemContext } = await import('../chat/system-prompt.mjs');
const context = await buildSystemContext({ sessionId: 'session-test-gmail' });

assert.match(context, /### Gmail/);
assert.match(context, /remotelab gmail status --json/);
assert.match(context, /remotelab gmail --help/);
assert.match(context, /\/connectors\/gmail/);
assert.match(context, /Do not claim Gmail is unavailable, ask for IMAP credentials, or say there is no access until you have checked the live Gmail status/);
assert.match(context, /If Gmail status is `ready`, use the Gmail CLI for the mailbox task/);

console.log('test-system-prompt-gmail: ok');
