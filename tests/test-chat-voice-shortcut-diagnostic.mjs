#!/usr/bin/env node
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { handleControlRoutes } from '../chat/router-control-routes.mjs';

async function submit(payload, personId = 'person_test') {
  const body = JSON.stringify(payload);
  const req = Readable.from([body]);
  req.method = 'POST';
  req.headers = { 'content-length': String(Buffer.byteLength(body)) };
  let response = null;
  const lines = [];
  const originalInfo = console.info;
  console.info = (...parts) => lines.push(parts.join(' '));
  try {
    const handled = await handleControlRoutes({
      req,
      res: {},
      pathname: '/api/voice-shortcut/recording-diagnostic',
      authSession: personId ? { personId } : null,
      writeJson(_res, status, value) { response = { status, value }; },
    });
    assert.equal(handled, true);
  } finally {
    console.info = originalInfo;
  }
  return { response, lines };
}

const attempt = await submit({
  attemptId: 'test-123',
  phase: 'stop',
  outcome: 'empty',
  events: [
    { type: 'down', modifier: 'Shift', shift: true, atMs: 12, key: 'secret' },
    { type: 'down', modifier: 'Alt', alt: true, shift: false, atMs: 35, key: 'secret' },
  ],
});
assert.equal(attempt.response.status, 200);
assert.equal(attempt.lines.length, 1);
assert.match(attempt.lines[0], /"modifier":"Shift"/);
assert.doesNotMatch(attempt.lines[0], /secret/, 'the diagnostic must never log raw key content');
assert.equal((await submit({ attemptId: 'test-123', phase: 'start' }, '')).response.status, 401);
assert.equal((await submit({ attemptId: 'bad id', phase: 'stop' })).response.status, 400);
console.log('test-chat-voice-shortcut-diagnostic: ok');
