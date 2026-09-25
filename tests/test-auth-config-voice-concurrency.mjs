#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const configDir = await mkdtemp(join(tmpdir(), 'remotelab-voice-auth-'));
process.env.REMOTELAB_CONFIG_DIR = configDir;

try {
  const { loadAuthDocument, updateAuthDocument } = await import('../lib/auth-config.mjs');
  const authPath = join(configDir, 'auth.json');
  await writeFile(authPath, JSON.stringify({
    version: 2,
    serviceToken: 'test-token',
    primaryPersonId: 'test-person',
    people: [{ id: 'test-person', name: 'Test person', credentials: [], identities: [] }],
  }));

  const readers = Array.from({ length: 40 }, () => loadAuthDocument());
  const save = updateAuthDocument((document) => {
    document.people[0].preferences.voiceShortcut = { enabled: true, binding: 'Shift+CapsLock' };
  });
  await Promise.all([...readers, save, ...Array.from({ length: 40 }, () => loadAuthDocument())]);

  const persisted = JSON.parse(await readFile(authPath, 'utf8'));
  assert.deepEqual(persisted.people[0].preferences.voiceShortcut, {
    enabled: true,
    binding: 'Shift+CapsLock',
  }, 'normalization reads must not overwrite a concurrently saved shortcut');
  assert.deepEqual((await loadAuthDocument()).people[0].preferences.voiceShortcut,
    persisted.people[0].preferences.voiceShortcut);
} finally {
  await rm(configDir, { recursive: true, force: true });
}

console.log('test-auth-config-voice-concurrency: ok');
