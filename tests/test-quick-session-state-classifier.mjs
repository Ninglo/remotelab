#!/usr/bin/env node
import assert from 'node:assert/strict';

import { createSessionTurnCompletionHelpers } from '../chat/session-turn-completion.mjs';

let classifierCalls = 0;
const helpers = createSessionTurnCompletionHelpers({
  applySessionStateSuggestion: async () => {},
  getSessionQueueCount: () => 0,
  isInternalSession: () => false,
  triggerSessionStateSuggestion: async () => {
    classifierCalls += 1;
    return { ok: false };
  },
});

assert.equal(
  helpers.scheduleSessionStateSuggestion(
    { id: 'quick-session', executionProfile: ' QUICK ' },
    { id: 'quick-run', state: 'completed', tool: 'codex', model: 'gpt-5.6-luna' },
  ),
  false,
  'Quick Sessions must not launch a second provider turn for metadata classification',
);
assert.equal(classifierCalls, 0);

assert.equal(
  helpers.scheduleSessionStateSuggestion(
    { id: 'standard-session', executionProfile: 'standard' },
    { id: 'standard-run', state: 'completed', tool: 'codex', model: 'gpt-5.6-luna' },
  ),
  true,
  'Standard Sessions retain post-turn state classification',
);
await new Promise(resolve => setImmediate(resolve));
assert.equal(classifierCalls, 1);

console.log('test-quick-session-state-classifier: ok');
