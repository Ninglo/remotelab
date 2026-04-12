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
process.env.REMOTELAB_DISABLE_EMBEDDED_MAIL_WORKER = '1';

try {
  const { initializeMailbox } = await import(pathToFileURL(join(repoRoot, 'lib', 'agent-mailbox.mjs')).href);
  const { startEmbeddedMailWorker } = await import(pathToFileURL(join(repoRoot, 'lib', 'embedded-mail-worker.mjs')).href);

  await initializeMailbox({
    rootDir: join(tempHome, '.config', 'remotelab', 'agent-mailbox'),
    name: 'Rowan',
    localPart: 'rowan',
    domain: 'example.com',
    allowEmails: ['owner@example.com'],
  });

  const worker = await startEmbeddedMailWorker({
    createSession: async () => {
      throw new Error('embedded mail worker should not start when disabled');
    },
    submitHttpMessage: async () => {
      throw new Error('embedded mail worker should not start when disabled');
    },
    saveAttachments: async () => [],
  });

  assert.equal(worker, null);
  console.log('embedded mail worker disable flag test passed');
} finally {
  delete process.env.REMOTELAB_DISABLE_EMBEDDED_MAIL_WORKER;
  rmSync(tempHome, { recursive: true, force: true });
}
