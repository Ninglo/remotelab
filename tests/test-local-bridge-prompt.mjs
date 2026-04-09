#!/usr/bin/env node
import assert from 'assert/strict';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

async function importFresh(relativePath) {
  const href = pathToFileURL(join(repoRoot, relativePath)).href;
  return import(`${href}?test=${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

const { buildLocalBridgePromptBlock } = await importFresh('chat/local-bridge-prompt.mjs');

const empty = buildLocalBridgePromptBlock({});
assert.equal(empty, '', 'prompt block should be omitted when no local bridge is linked');

const block = buildLocalBridgePromptBlock({
  localBridge: {
    deviceId: 'ldev_123',
    state: 'online',
    deviceName: 'Mac Test Helper',
    platform: 'darwin',
    allowedRoots: [{ alias: 'projects', path: '/Users/alice/Projects' }],
  },
});

assert.match(block, /Local Helper Bridge/, 'prompt block should identify the local helper bridge');
assert.match(block, /Mac Test Helper/, 'prompt block should surface the linked device name');
assert.match(block, /`projects`/, 'prompt block should surface allowed root aliases');
assert.match(block, /remotelab local-bridge list/, 'prompt block should include list CLI guidance');
assert.match(block, /remotelab local-bridge stage/, 'prompt block should include stage CLI guidance');

console.log('test-local-bridge-prompt: ok');

