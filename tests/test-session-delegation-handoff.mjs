#!/usr/bin/env node
import assert from 'assert/strict';

const { buildDelegationHandoff } = await import('../chat/session-context-compaction.mjs');

const handoff = buildDelegationHandoff({
  source: { id: 'parent-session-123' },
  task: 'Create a new independent bug workflow for the current issue. Do not merge into existing issue threads.',
});

assert.match(handoff, /^Delegation handoff:/);
assert.match(handoff, /already in the delegated target session/i);
assert.match(handoff, /exactly one focused task/i);
assert.match(handoff, /Complete it directly in this session/);
assert.match(handoff, /Do NOT use session-spawn or delegate further/);
assert.match(handoff, /Create a new independent bug workflow for the current issue\./);
assert.match(handoff, /Parent session id: parent-session-123/);

// Test without source id
const handoffNoSource = buildDelegationHandoff({
  source: {},
  task: 'Simple task',
});
assert.match(handoffNoSource, /^Delegation handoff:/);
assert.ok(!handoffNoSource.includes('Parent session id:'), 'Should not include parent session id when empty');

console.log('test-session-delegation-handoff: ok');
