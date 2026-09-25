import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { handleClaudeAuthRoutes } from '../chat/router-claude-auth-routes.mjs';

const calls = [];
const authManager = {
  getStatus: async () => ({ loggedIn: false, apiKeyOverride: true }),
  startLogin: async input => { calls.push(['login', input]); return { phase: 'awaiting' }; },
  submitCode: async code => { calls.push(['code', code]); return { phase: 'verifying' }; },
  logout: async () => { calls.push(['logout']); return { phase: 'idle' }; },
};
async function request(method, pathname, body = '') {
  const req = Readable.from(body ? [body] : []);
  req.method = method;
  const res = { setHeader() {} };
  let response;
  const handled = await handleClaudeAuthRoutes({
    req, res, pathname, authManager,
    writeJson: (_res, status, payload) => { response = { status, payload }; },
  });
  assert.equal(handled, true);
  return response;
}

assert.equal((await request('GET', '/api/claude-auth/status')).payload.claudeAuth.apiKeyOverride, true);
assert.equal((await request('POST', '/api/claude-auth/login', '{"restart":true}')).status, 200);
assert.deepEqual(calls[0], ['login', { restart: true }]);
const codeResponse = await request('POST', '/api/claude-auth/code', '{"code":"fixture-code"}');
assert.equal(codeResponse.status, 200);
assert.deepEqual(calls[1], ['code', 'fixture-code']);
assert.ok(!JSON.stringify(codeResponse).includes('fixture-code'), 'login code must not be echoed');
assert.equal((await request('POST', '/api/claude-auth/logout')).status, 200);
assert.deepEqual(calls[2], ['logout']);
assert.equal((await request('POST', '/api/claude-auth/code', '{')).status, 400);

console.log('Claude auth route tests passed');
