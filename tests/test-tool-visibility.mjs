#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-tool-visibility-'));
const fakeBin = join(tempHome, '.local', 'bin');
const configDir = join(tempHome, '.config', 'remotelab');

mkdirSync(fakeBin, { recursive: true });
mkdirSync(configDir, { recursive: true });

for (const command of ['public-helper', 'private-helper']) {
  const path = join(fakeBin, command);
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
}

writeFileSync(
  join(configDir, 'tools.json'),
  `${JSON.stringify([
    {
      id: 'public-helper',
      name: 'Public Helper',
      command: 'public-helper',
      runtimeFamily: 'claude-stream-json',
      models: [{ id: 'public-helper-v1', label: 'Public Helper v1' }],
      reasoning: { kind: 'toggle', label: 'Thinking' },
    },
    {
      id: 'private-helper',
      name: 'Private Helper',
      command: 'private-helper',
      visibility: 'private',
      runtimeFamily: 'claude-stream-json',
      models: [{ id: 'private-helper-v1', label: 'Private Helper v1' }],
      reasoning: { kind: 'toggle', label: 'Thinking' },
    },
  ], null, 2)}\n`,
  'utf8',
);

process.env.HOME = tempHome;
process.env.PATH = `${fakeBin}:${process.env.PATH || ''}`;

const toolsModule = await import(pathToFileURL(join(repoRoot, 'lib', 'tools.mjs')).href);
const { getAvailableTools } = toolsModule;

try {
  const tools = getAvailableTools();
  const publicTool = tools.find((tool) => tool.id === 'public-helper');
  const privateTool = tools.find((tool) => tool.id === 'private-helper');
  const builtinClaude = tools.find((tool) => tool.id === 'claude');

  assert.ok(publicTool, 'public tool should be returned');
  assert.ok(privateTool, 'private tool should still be returned to the owner runtime');
  assert.ok(builtinClaude, 'builtin Claude tool should still be returned to the owner runtime');
  assert.equal(publicTool?.available, true);
  assert.equal(privateTool?.available, true);
  assert.equal(publicTool?.visibility || '', '', 'public tools should not be forced private');
  assert.equal(privateTool?.visibility, 'private', 'private visibility should survive normalization');
  assert.equal(builtinClaude?.visibility || '', '', 'builtin Claude should be visible in normal pickers');
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}

console.log('test-tool-visibility: ok');
