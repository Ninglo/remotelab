#!/usr/bin/env node
import assert from 'assert/strict';
import { readFile } from 'fs/promises';

const bootstrap = await readFile(new URL('../static/chat/bootstrap.js', import.meta.url), 'utf8');

assert.match(
  bootstrap,
  /const PRODUCT_DEFAULT_CODEX_EFFORT = "xhigh";/,
  'new Codex sessions should default to xhigh',
);
assert.match(
  bootstrap,
  /CODEX_EFFORT_DEFAULT_MIGRATION_VERSION = "xhigh-v1"/,
  'existing browsers should receive the one-time xhigh preference migration',
);
assert.match(
  bootstrap,
  /localStorage\.setItem\(`selectedEffort_\$\{DEFAULT_TOOL_ID\}`, PRODUCT_DEFAULT_CODEX_EFFORT\)/,
  'the migration should persist xhigh for Codex',
);

console.log('test-codex-xhigh-default: ok');
