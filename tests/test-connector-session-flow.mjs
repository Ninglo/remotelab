#!/usr/bin/env node
import assert from 'assert/strict';

import { createConnectorSession } from '../lib/connector-turn-flow.mjs';

const calls = [];
const requester = async (path, options = {}) => {
  calls.push({ path, options });
  if (path === '/api/sessions/parent-session/fork') {
    return {
      response: { ok: true, status: 201 },
      json: { session: { id: 'child-session' } },
      text: '',
    };
  }
  throw new Error(`unexpected request: ${path}`);
};

const payload = {
  externalTriggerId: 'feishu:topic:chat-1:thread-1',
  sourceContext: { connector: 'feishu', topicId: 'thread-1' },
};
const forked = await createConnectorSession(requester, payload, {
  forkFromSessionId: 'parent-session',
});
assert.equal(forked.id, 'child-session');
assert.deepEqual(calls, [{
  path: '/api/sessions/parent-session/fork',
  options: { method: 'POST', body: payload },
}]);

const fallbackCalls = [];
const fallbackRequester = async (path, options = {}) => {
  fallbackCalls.push({ path, options });
  if (path.endsWith('/fork')) {
    return { response: { ok: false, status: 409 }, json: { error: 'busy' }, text: '' };
  }
  return {
    response: { ok: true, status: 201 },
    json: { session: { id: 'fresh-session' } },
    text: '',
  };
};
const fresh = await createConnectorSession(fallbackRequester, payload, {
  forkFromSessionId: 'busy-parent',
  fallbackCreateOnForkFailure: true,
});
assert.equal(fresh.id, 'fresh-session');
assert.deepEqual(fallbackCalls.map((call) => call.path), [
  '/api/sessions/busy-parent/fork',
  '/api/sessions',
]);

await assert.rejects(
  createConnectorSession(fallbackRequester, payload, { forkFromSessionId: 'busy-parent' }),
  /busy/,
);

console.log('ok - connector session flow supports fork and explicit fresh-create fallback');
