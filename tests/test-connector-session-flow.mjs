#!/usr/bin/env node
import assert from 'assert/strict';

import {
  assertConnectorPublicationReady,
  createConnectorSession,
  normalizeConnectorPublicationText,
  waitForConnectorPublication,
} from '../lib/connector-turn-flow.mjs';

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

const readyPublication = { state: 'ready', lastError: '' };
assert.equal(assertConnectorPublicationReady(readyPublication), readyPublication);
assert.throws(
  () => assertConnectorPublicationReady({
    state: 'failed',
    lastError: '429 Organization concurrency limit exceeded',
  }),
  (error) => {
    assert.equal(error.code, 'reply_publication_failed');
    assert.equal(error.publicationState, 'failed');
    assert.match(error.message, /Organization concurrency limit exceeded/);
    return true;
  },
  'connector publication failures should preserve the final provider reason',
);
assert.throws(
  () => assertConnectorPublicationReady({ state: 'cancelled' }),
  (error) => error.code === 'reply_publication_cancelled' && error.publicationState === 'cancelled',
);

let resilientPollCalls = 0;
const resilientPublication = await waitForConnectorPublication(async () => {
  resilientPollCalls += 1;
  if (resilientPollCalls === 1) {
    return {
      response: { ok: true, status: 200 },
      json: { replyPublication: { state: 'pending' } },
      text: '',
    };
  }
  if (resilientPollCalls === 2) {
    const error = new TypeError('fetch failed');
    error.cause = { code: 'ECONNRESET' };
    throw error;
  }
  if (resilientPollCalls === 3) {
    return {
      response: { ok: false, status: 503 },
      json: { error: 'service restarting' },
      text: '',
    };
  }
  return {
    response: { ok: true, status: 200 },
    json: { replyPublication: { state: 'ready', payload: { text: 'recovered reply' } } },
    text: '',
  };
}, 'restart-session', 'restart-response', {
  timeoutMs: 100,
  intervalMs: 1,
});
assert.equal(resilientPublication.state, 'ready');
assert.equal(resilientPublication.payload.text, 'recovered reply');
assert.equal(resilientPollCalls, 4, 'connector polling should survive transient transport and restart responses');

let terminalPollCalls = 0;
await assert.rejects(
  waitForConnectorPublication(async () => {
    terminalPollCalls += 1;
    return {
      response: { ok: false, status: 400 },
      json: { error: 'invalid response id' },
      text: '',
    };
  }, 'invalid-session', 'invalid-response', {
    timeoutMs: 100,
    intervalMs: 1,
  }),
  /invalid response id/,
  'non-transient publication errors should still fail immediately',
);
assert.equal(terminalPollCalls, 1);

let outagePollCalls = 0;
await assert.rejects(
  waitForConnectorPublication(async () => {
    outagePollCalls += 1;
    throw new TypeError('fetch failed');
  }, 'outage-session', 'outage-response', {
    timeoutMs: 10,
    intervalMs: 1,
  }),
  /reply publication timed out after 10ms/,
  'bounded waits should keep their overall deadline during a transport outage',
);
assert.ok(outagePollCalls > 1);

const attachmentReplyText = normalizeConnectorPublicationText({
  payload: {
    text: '已完成\n\n查看会话详情和进度：https://remote.example.test/?session=session-1&tab=sessions',
    displayEvents: [{ type: 'message', role: 'assistant', content: '已完成' }],
    sessionEntry: {
      url: 'https://remote.example.test/?session=session-1&tab=sessions',
      label: '查看会话详情和进度',
    },
  },
}, { includeAttachmentFallback: false });
assert.equal(
  attachmentReplyText,
  '已完成\n\n查看会话详情和进度：https://remote.example.test/?session=session-1&tab=sessions',
  'attachment-bearing connector replies should retain the shared session entry footer',
);

console.log('ok - connector session flow supports fork and explicit fresh-create fallback');
console.log('ok - connector publication failures preserve provider reasons');
console.log('ok - connector publication polling survives transient service interruptions');
