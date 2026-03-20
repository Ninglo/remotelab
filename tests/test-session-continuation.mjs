#!/usr/bin/env node
import assert from 'assert/strict';

const {
  buildSessionContinuationContextFromBody,
} = await import('../chat/session-continuation.mjs');

const defaultContext = buildSessionContinuationContextFromBody('[User]\ncontinue');
assert.match(defaultContext, /RemoteLab session continuity handoff for this existing conversation/);

const switchedContext = buildSessionContinuationContextFromBody('[User]\ncontinue', {
  fromTool: 'claude',
  toTool: 'codex',
});
assert.match(switchedContext, /RemoteLab session continuity handoff: the user switched tools from claude to codex/);

console.log('test-session-continuation: ok');
