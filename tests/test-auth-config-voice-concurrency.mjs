#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const configDir = await mkdtemp(join(tmpdir(), 'remotelab-voice-auth-'));
process.env.REMOTELAB_CONFIG_DIR = configDir;

try {
  const { loadAuthDocument, readPrimaryAccessToken, readServiceToken, updateAuthDocument } = await import('../lib/auth-config.mjs');
  const authPath = join(configDir, 'auth.json');
  const forwardCompatibleDocument = JSON.stringify({
    version: 2,
    serviceToken: 'service-token',
    primaryPersonId: 'test-person',
    people: [{
      id: 'test-person', name: 'Test person', credentials: [{ type: 'token', token: 'access-token' }], identities: [],
      preferences: { futurePreference: { enabled: true } },
    }],
  });
  await writeFile(authPath, forwardCompatibleDocument);
  assert.equal(await readServiceToken(authPath), 'service-token');
  assert.equal(await readPrimaryAccessToken(authPath), 'access-token');
  assert.equal(await readFile(authPath, 'utf8'), forwardCompatibleDocument,
    'credential reads must never rewrite another process\'s auth document');
  assert.deepEqual((await loadAuthDocument({ persistMigration: false })).people[0].preferences.futurePreference,
    { enabled: true }, 'normalization must preserve preferences added by newer releases');

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
