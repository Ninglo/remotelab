#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-shared-tools-'));
const sharedToolsDir = join(tempHome, '.remotelab', 'shared-tools');
const configDir = join(tempHome, '.config', 'remotelab');

mkdirSync(join(sharedToolsDir, 'review-helper'), { recursive: true });
mkdirSync(join(sharedToolsDir, 'skipped-helper'), { recursive: true });
mkdirSync(configDir, { recursive: true });

const reviewCommandPath = join(sharedToolsDir, 'review-helper', 'run-review');
writeFileSync(reviewCommandPath, '#!/bin/sh\nexit 0\n', 'utf8');
chmodSync(reviewCommandPath, 0o755);

writeFileSync(
  join(sharedToolsDir, 'review-helper', 'TOOL.md'),
  `---
runtimeFamily: codex-json
command: ./run-review
visibility: private
---
# Review Helper

Lightweight shared review helper.
`,
  'utf8',
);

writeFileSync(
  join(sharedToolsDir, 'skipped-helper', 'TOOL.md'),
  `---
runtimeFamily: claude-stream-json
command: claude
---
# Skipped Helper
`,
  'utf8',
);

writeFileSync(
  join(configDir, 'tools-enabled.md'),
  '# Enabled shared tools\n- review-helper\n',
  'utf8',
);

process.env.HOME = tempHome;

const { getAvailableTools } = await import(pathToFileURL(join(repoRoot, 'lib', 'tools.mjs')).href);

try {
  const tools = await getAvailableTools();
  const reviewHelper = tools.find((tool) => tool.id === 'review-helper');
  const skippedHelper = tools.find((tool) => tool.id === 'skipped-helper');

  assert.ok(reviewHelper, 'enabled shared tool should be loaded');
  assert.equal(reviewHelper?.name, 'Review Helper');
  assert.equal(reviewHelper?.command, reviewCommandPath, 'relative shared tool command should resolve from the tool folder');
  assert.equal(reviewHelper?.runtimeFamily, 'codex-json');
  assert.equal(reviewHelper?.visibility, 'private');
  assert.equal(reviewHelper?.builtin, false);
  assert.equal(reviewHelper?.available, true);
  assert.equal(skippedHelper, undefined, 'non-enabled shared tool should stay hidden when tools-enabled.md is present');
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}

console.log('test-shared-tools-directory: ok');
