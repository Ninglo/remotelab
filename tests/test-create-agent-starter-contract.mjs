#!/usr/bin/env node
import assert from 'assert/strict';

import {
  CREATE_AGENT_STARTER_MESSAGE,
  CREATE_AGENT_STARTER_SYSTEM_PROMPT,
  resolveStarterPresetDefinition,
} from '../chat/starter-session-content.mjs';

assert.match(CREATE_AGENT_STARTER_SYSTEM_PROMPT, /every new Agent session as an independent invocation/i);
assert.match(CREATE_AGENT_STARTER_SYSTEM_PROMPT, /prior chat transcripts, project\/task memory, historical business records/i);
assert.match(CREATE_AGENT_STARTER_SYSTEM_PROMPT, /existence of old files, tables, campaigns, or session notes is not permission/i);
assert.match(CREATE_AGENT_STARTER_SYSTEM_PROMPT, /Review Gates are binding interaction checkpoints/);
assert.match(CREATE_AGENT_STARTER_SYSTEM_PROMPT, /run a clean-room dry-run in a newly created Agent session/);
assert.match(CREATE_AGENT_STARTER_SYSTEM_PROMPT, /must not trigger external side effects/);

const definition = resolveStarterPresetDefinition('create_agent');
assert.equal(definition?.systemPrompt, CREATE_AGENT_STARTER_SYSTEM_PROMPT);
assert.equal(definition?.welcomeMessage, CREATE_AGENT_STARTER_MESSAGE);

console.log('test-create-agent-starter-contract: ok');
