import assert from 'node:assert/strict';
import * as Lark from '@larksuiteoapi/node-sdk';
import { createFeishuHttpInstance } from '../lib/feishu-http-client.mjs';

const calls = [];
const transport = { request: async options => { calls.push(options); return { ok: true }; } };
const http = createFeishuHttpInstance(transport);
for (const method of ['get', 'delete', 'head', 'options']) {
  await http[method]('/test', { headers: { test: 'value' } });
  assert.equal(calls.at(-1).method, method.toUpperCase());
  assert.equal(calls.at(-1).timeout, 30000);
  assert(calls.at(-1).signal instanceof AbortSignal);
}
for (const method of ['post', 'put', 'patch']) {
  await http[method]('/test', { value: 1 }, { timeout: 1000 });
  assert.equal(calls.at(-1).method, method.toUpperCase());
  assert.deepEqual(calls.at(-1).data, { value: 1 });
  assert.equal(calls.at(-1).timeout, 1000);
}
const controller = new AbortController();
await http.request({ url: '/test', timeout: 60000, signal: controller.signal });
const signal = calls.at(-1).signal;
assert.equal(calls.at(-1).timeout, 30000);
controller.abort();
assert.equal(signal.aborted, true);

// Real SDK call path, entirely mocked network: its token manager invokes post().
const sdkCalls = [];
const sdkTransport = createFeishuHttpInstance({ request: async options => {
  sdkCalls.push(options);
  if (options.url.includes('/auth/')) {
    return { code: 0, expire: 7200, tenant_access_token: 'fixture-tenant-token', app_access_token: 'fixture-app-token' };
  }
  return { code: 0, data: { message_id: 'fixture-message-id' } };
} });
const client = new Lark.Client({ appId: 'fixture-app', appSecret: 'fixture-secret', httpInstance: sdkTransport,
  loggerLevel: Lark.LoggerLevel.error });
const result = await client.request({ url: '/open-apis/bot/v3/info', method: 'GET' });
assert.equal(result.code, 0);
assert(sdkCalls.some(call => call.url.includes('/auth/') && call.method?.toUpperCase() === 'POST'),
  JSON.stringify(sdkCalls.map(({ url, method }) => ({ url, method }))));
assert(sdkCalls.every(call => call.timeout <= 30000 && call.signal instanceof AbortSignal));
console.log('PASS: bounded Feishu request/verb transport and real SDK token acquisition with mocked network');
