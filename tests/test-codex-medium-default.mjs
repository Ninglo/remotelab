#!/usr/bin/env node
import assert from 'assert/strict';
import { readFile } from 'fs/promises';

const bootstrap = await readFile(new URL('../static/chat/bootstrap.js', import.meta.url), 'utf8');

assert.match(
  bootstrap,
  /const PRODUCT_DEFAULT_CODEX_EFFORT = "medium";/,
  'new Codex sessions should default to medium',
);
assert.match(
  bootstrap,
  /CODEX_EFFORT_DEFAULT_MIGRATION_VERSION = "medium-v1"/,
  'existing browsers should receive the one-time medium preference migration',
);
assert.match(
  bootstrap,
  /localStorage\.setItem\(`selectedEffort_\$\{DEFAULT_TOOL_ID\}`, PRODUCT_DEFAULT_CODEX_EFFORT\)/,
  'the migration should persist medium for Codex',
);

console.log('test-codex-medium-default: ok');
