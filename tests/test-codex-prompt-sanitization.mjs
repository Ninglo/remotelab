#!/usr/bin/env node
import assert from 'assert/strict';

import { buildCodexArgs } from '../chat/adapters/codex.mjs';

const promptWithNul = 'history before\u0000history after';
const freshArgs = buildCodexArgs(promptWithNul);
assert.equal(freshArgs.some((arg) => typeof arg === 'string' && arg.includes('\u0000')), false);
assert.match(freshArgs[freshArgs.length - 1], /history before/);
assert.match(freshArgs[freshArgs.length - 1], /history after/);

const resumeArgs = buildCodexArgs(promptWithNul, { threadId: 'codex-thread-1' });
assert.equal(resumeArgs.some((arg) => typeof arg === 'string' && arg.includes('\u0000')), false);

console.log('test-codex-prompt-sanitization: ok');
