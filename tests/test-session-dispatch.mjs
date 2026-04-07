#!/usr/bin/env node
import assert from 'assert/strict';

const { shouldRunDispatch } = await import('../chat/session-dispatch.mjs');

process.env.REMOTELAB_SESSION_DISPATCH = 'on';

assert.equal(
  shouldRunDispatch({ id: 'session-1' }, {
    internalOperation: 'reply_self_repair',
  }),
  false,
  'internal continuation turns should not re-enter dispatch routing',
);

assert.equal(
  shouldRunDispatch({ id: 'session-1' }, {
    recordUserMessage: false,
    queueIfBusy: false,
  }),
  false,
  'follow-up turns without a recorded user message should not dispatch again',
);

assert.equal(
  shouldRunDispatch({ id: 'session-1' }, {}),
  true,
  'normal user turns should still be eligible for dispatch classification',
);

console.log('test-session-dispatch: ok');
