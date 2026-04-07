#!/usr/bin/env node
/**
 * Integration test: delegated child sessions must NOT receive the
 * "Parallel Session Spawning" section in their system prompt.
 *
 * This prevents recursive spawn explosions where a child session
 * inherits spawn instructions and keeps splitting indefinitely.
 */
import assert from 'assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'remotelab-child-spawn-'));
process.env.HOME = tempHome;
process.env.REMOTELAB_PUBLIC_BASE_URL = '';

await fs.mkdir(path.join(tempHome, '.config', 'remotelab'), { recursive: true });
await fs.writeFile(
  path.join(tempHome, '.config', 'remotelab', 'tools.json'),
  JSON.stringify([]),
  'utf8',
);

const { buildPrompt } = await import('../chat/session-manager.mjs');

const baseSession = {
  systemPrompt: '',
  visitorId: '',
  claudeSessionId: null,
  codexThreadId: null,
  activeAgreements: [],
};

// --- Test 1: Normal session INCLUDES spawn instructions ---
const normalPrompt = await buildPrompt(
  'session-normal',
  { ...baseSession },
  'Hello',
  'codex',
  'codex',
  null,
  { skipSessionContinuation: true },
);

assert.match(
  normalPrompt,
  /Parallel Session Spawning/,
  'Normal session must include the Parallel Session Spawning section',
);
assert.match(
  normalPrompt,
  /session-spawn/,
  'Normal session must include session-spawn CLI command',
);

// --- Test 2: Delegated child (delegationDepth > 0) does NOT include spawn ---
const childPrompt = await buildPrompt(
  'session-child',
  { ...baseSession, delegationDepth: 1, delegatedFromSessionId: 'session-normal' },
  'Delegation handoff:\n- You are already in the delegated target session.\n\nDo this specific task.',
  'codex',
  'codex',
  null,
  { skipSessionContinuation: true },
);

assert.doesNotMatch(
  childPrompt,
  /## Parallel Session Spawning/,
  'Delegated child must NOT include the Parallel Session Spawning heading',
);
assert.doesNotMatch(
  childPrompt,
  /remotelab session-spawn/,
  'Delegated child must NOT include session-spawn CLI commands',
);

// --- Test 3: Deeper delegation (depth 2) also excluded ---
const grandchildPrompt = await buildPrompt(
  'session-grandchild',
  { ...baseSession, delegationDepth: 2, delegatedFromSessionId: 'session-child' },
  'Delegation handoff:\n- Nested task.\n\nDo this sub-task.',
  'codex',
  'codex',
  null,
  { skipSessionContinuation: true },
);

assert.doesNotMatch(
  grandchildPrompt,
  /## Parallel Session Spawning/,
  'Grandchild session must NOT include spawn section',
);

// --- Test 4: delegationDepth=0 still gets spawn (edge case: explicitly set but zero) ---
const depthZeroPrompt = await buildPrompt(
  'session-depth-zero',
  { ...baseSession, delegationDepth: 0 },
  'A regular message.',
  'codex',
  'codex',
  null,
  { skipSessionContinuation: true },
);

assert.match(
  depthZeroPrompt,
  /Parallel Session Spawning/,
  'Session with delegationDepth=0 should still include spawn section',
);

console.log('test-delegated-child-no-spawn-prompt: ok');
