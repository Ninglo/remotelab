#!/usr/bin/env node
import assert from 'assert/strict';

import { buildClaudeArgs } from '../chat/adapters/claude.mjs';

const explicitEffort = buildClaudeArgs('hello world', {
  model: 'sonnet',
  effort: 'medium',
});
assert.deepEqual(
  explicitEffort.slice(-4),
  ['--model', 'sonnet', '--effort', 'medium'],
  'explicit Claude effort should pass through to the CLI args',
);

const thinkingFallback = buildClaudeArgs('hello world', {
  model: 'sonnet',
  thinking: true,
});
assert.deepEqual(
  thinkingFallback.slice(-4),
  ['--model', 'sonnet', '--effort', 'high'],
  'thinking toggle should still map to high effort when no explicit effort is set',
);

const explicitWins = buildClaudeArgs('hello world', {
  model: 'sonnet',
  effort: 'low',
  thinking: true,
});
assert.deepEqual(
  explicitWins.slice(-4),
  ['--model', 'sonnet', '--effort', 'low'],
  'explicit Claude effort should win over the legacy thinking fallback',
);

console.log('test-claude-build-args: ok');
