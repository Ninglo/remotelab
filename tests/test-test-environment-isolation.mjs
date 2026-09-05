#!/usr/bin/env node
import assert from 'assert/strict';
import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const testsDir = dirname(fileURLToPath(import.meta.url));
const persistentModulePattern = /(?:chat\/(?:session-manager|history|runs|session-meta-store|apps)|lib\/(?:config|agent-mailbox|agent-mail-outbound))\.mjs/;
const unsafe = [];

for (const name of readdirSync(testsDir)) {
  if (!name.endsWith('.mjs') || name === 'test-test-environment-isolation.mjs') continue;
  const source = readFileSync(join(testsDir, name), 'utf8');
  if (!/process\.env\.HOME\s*=/.test(source) || !persistentModulePattern.test(source)) continue;

  const usesSharedIsolation = /setIsolatedTestHome\s*\(/.test(source);
  const clearsInstanceRoot = /delete process\.env\.REMOTELAB_INSTANCE_ROOT/.test(source);
  const controlsConfigDir = /(?:delete\s+)?process\.env\.REMOTELAB_CONFIG_DIR/.test(source);
  if (!usesSharedIsolation && !(clearsInstanceRoot && controlsConfigDir)) unsafe.push(name);
}

assert.deepEqual(
  unsafe,
  [],
  'tests that change HOME and load persistent RemoteLab modules must isolate inherited instance/config state',
);

console.log('test-test-environment-isolation: ok');
