#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-tool-priority-'));
const fakeBin = join(tempHome, '.local', 'bin');
mkdirSync(fakeBin, { recursive: true });

for (const command of ['codex', 'claude', 'copilot']) {
  const path = join(fakeBin, command);
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
}

process.env.HOME = tempHome;
process.env.PATH = `${fakeBin}:${process.env.PATH || ''}`;

const toolsModule = await import(pathToFileURL(join(repoRoot, 'lib', 'tools.mjs')).href);
const { getAvailableTools } = toolsModule;

try {
  const tools = getAvailableTools().filter((tool) => tool.available);
  assert.ok(tools.length >= 3, 'fake built-in tools should be discoverable');
  assert.equal(tools[0]?.id, 'codex', 'CodeX/codex should be listed first');
  assert.equal(tools[0]?.name, 'CodeX', 'codex should use the CodeX display label');
  assert.equal(tools[1]?.id, 'claude', 'Claude Code should follow CodeX');
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}

console.log('test-tool-priority: ok');
