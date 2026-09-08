#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const repoRoot = process.cwd();
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-embedded-mail-worker-'));

delete process.env.REMOTELAB_INSTANCE_ROOT;
delete process.env.REMOTELAB_CONFIG_DIR;
delete process.env.REMOTELAB_MEMORY_DIR;
process.env.HOME = tempHome;

try {
  const mailboxRoot = join(tempHome, '.config', 'remotelab', 'agent-mailbox');
  const { initializeMailbox, saveMailboxAutomation } = await import(pathToFileURL(join(repoRoot, 'lib', 'agent-mailbox.mjs')).href);
  const { resolveEmailConnectorBinding } = await import(pathToFileURL(join(repoRoot, 'lib', 'connector-bindings.mjs')).href);
  const { startEmbeddedMailWorker } = await import(pathToFileURL(join(repoRoot, 'lib', 'embedded-mail-worker.mjs')).href);

  await initializeMailbox({
    rootDir: mailboxRoot,
    name: 'Rowan',
    localPart: 'rowan',
    domain: 'example.com',
    allowEmails: ['owner@example.com'],
  });

  process.env.REMOTELAB_DISABLE_EMBEDDED_MAIL_WORKER = '1';
  const disabledWorker = await startEmbeddedMailWorker({
    createSession: async () => {
      throw new Error('embedded mail worker should not start when disabled');
    },
    submitHttpMessage: async () => {
      throw new Error('embedded mail worker should not start when disabled');
    },
    saveAttachments: async () => [],
  });
  assert.equal(disabledWorker, null);
  delete process.env.REMOTELAB_DISABLE_EMBEDDED_MAIL_WORKER;

  await saveMailboxAutomation(mailboxRoot, { enabled: false });

  const worker = await startEmbeddedMailWorker({
    createSession: async () => {
      throw new Error('embedded mail worker should not start when mailbox automation is disabled');
    },
    submitHttpMessage: async () => {
      throw new Error('embedded mail worker should not start when mailbox automation is disabled');
    },
    saveAttachments: async () => [],
  });

  assert.equal(worker, null);
  assert.ok(
    await resolveEmailConnectorBinding({ rootDir: mailboxRoot }),
    'server startup must persist the explicit email binding even when mailbox automation is disabled',
  );
  console.log('embedded mail worker disable flag and binding bootstrap tests passed');
} finally {
  delete process.env.REMOTELAB_DISABLE_EMBEDDED_MAIL_WORKER;
  rmSync(tempHome, { recursive: true, force: true });
}
