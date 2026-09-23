import assert from 'node:assert/strict';

import {
  applyQuickSessionRuntime,
  getQuickSessionDeveloperInstructions,
  getQuickSessionRuntimeProfile,
  isQuickSession,
  normalizeSessionExecutionProfile,
} from '../lib/quick-session-profile.mjs';

assert.equal(normalizeSessionExecutionProfile(' QUICK '), 'quick');
assert.equal(normalizeSessionExecutionProfile('standard'), '');
assert.equal(isQuickSession({ executionProfile: 'quick' }), true);
assert.deepEqual(getQuickSessionRuntimeProfile({}), {
  tool: 'codex', model: 'gpt-6-sol', effort: 'low', thinking: false,
});
assert.deepEqual(
  applyQuickSessionRuntime(
    { executionProfile: 'quick' },
    { tool: 'claude', model: 'opus', effort: 'high', thinking: true, sourceContext: { connector: 'feishu' } },
  ),
  {
    tool: 'codex', model: 'gpt-6-sol', effort: 'low', thinking: false,
    executionProfile: 'quick', sourceContext: { connector: 'feishu' },
  },
);
const developerInstructions = getQuickSessionDeveloperInstructions();
assert.match(developerInstructions, /Answer directly and concisely/);
assert.match(developerInstructions, /Use tools when the user explicitly requests them/);
assert.equal(getQuickSessionDeveloperInstructions('Custom quick prompt.'), 'Custom quick prompt.');

console.log('test-quick-session-profile: ok');
