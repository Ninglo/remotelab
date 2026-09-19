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
  tool: 'codex', model: 'gpt-5.6-terra', effort: 'low', thinking: false,
});
assert.deepEqual(
  applyQuickSessionRuntime(
    { executionProfile: 'quick' },
    { tool: 'claude', model: 'opus', effort: 'high', thinking: true, sourceContext: { connector: 'feishu' } },
  ),
  {
    tool: 'codex', model: 'gpt-5.6-terra', effort: 'low', thinking: false,
    executionProfile: 'quick', sourceContext: { connector: 'feishu' },
  },
);
const developerInstructions = getQuickSessionDeveloperInstructions();
assert.match(developerInstructions, /Do not proactively use tools/);
assert.match(developerInstructions, /explicitly requests tool use/);
assert.match(developerInstructions, /use the necessary available capabilities/);
assert.doesNotMatch(developerInstructions, /Do not call tools/);
assert.doesNotMatch(developerInstructions, /requires a Standard Session/);

console.log('test-quick-session-profile: ok');
