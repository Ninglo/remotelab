import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../display/studio-device-sync.js', import.meta.url), 'utf8');
async function scenario({ legacy = false, denied = false } = {}) {
  const requests = [];
  const elements = new Map();
  const storage = new Map(legacy ? [['remotelab.display-device-preview.v14', JSON.stringify({ token: 'a'.repeat(64) })]] : []);
  const listeners = new Map();
  let interval;
  let applied = false;
  for (const selector of ['#applyDevice', '#checkDevice', '#deviceStatus', '#deviceStatusTitle', '#deviceStatusMeta']) {
    elements.set(selector, { classList: { toggle() {} }, addEventListener(type, callback) { listeners.set(`${selector}:${type}`, callback); } });
  }
  const window = {
    addEventListener() {},
    displayStudioExportDevicePayload: async () => ({ version: 21, state: { theme: 'mist' } }),
    setInterval(callback) { interval = callback; },
  };
  const fetch = async (url, options) => {
    requests.push({ url, ...options });
    const isApply = options.method === 'POST';
    if (isApply) applied = true;
    const payload = denied ? { error: '当前账号没有连接到这块副屏。' } : isApply
      ? { frameId: '0123456789ab', statusToken: 'b'.repeat(64) }
      : { devices: [{ name: 'Own MacBook' }], ...(applied ? { preview: { frameId: '0123456789ab' }, delivery: { state: 'downloaded' } } : {}) };
    return { status: denied ? 403 : 200, ok: !denied, json: async () => payload };
  };
  runInNewContext(source, { window, document: { querySelector: (selector) => elements.get(selector), visibilityState: 'visible' },
    sessionStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    fetch, setTimeout, Date, Error, Boolean, Number, JSON, Promise });
  await new Promise(setImmediate);
  if (denied) {
    assert.equal(elements.get('#applyDevice').disabled, true);
    assert.equal(elements.get('#deviceStatusTitle').textContent, '尚未连接真机');
    return;
  }
  assert.equal(elements.get('#applyDevice').disabled, false);
  await listeners.get('#applyDevice:click')();
  assert.equal(elements.get('#deviceStatusTitle').textContent, '设备已拉取画面');
  interval();
  await new Promise(setImmediate);
  assert(requests.length >= 5);
  for (const request of requests) {
    assert.equal(request.url, `${legacy ? '/display' : '/api/display'}/studio-preview${request.method === 'POST' ? '' : '/status'}`);
    assert.equal(request.credentials, 'same-origin');
    assert.equal(request.headers.Authorization, legacy ? `Bearer ${'a'.repeat(64)}` : undefined,
      'an authenticated browser never sends an ephemeral status grant to the legacy channel');
  }
}
await scenario();
await scenario({ legacy: true });
await scenario({ denied: true });
console.log('ok - cookie apply and receipt reads stay on the same Person-scoped channel; legacy links remain isolated');
