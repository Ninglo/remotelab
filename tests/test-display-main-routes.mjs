#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  handleDisplayPublicRoutes,
  handleDisplaySettingsRoutes,
} from '../chat/router-display-routes.mjs';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch {}
  return { response, text, payload };
}

const root = await mkdtemp(join(tmpdir(), 'remotelab-display-routes-'));
const adminFile = join(root, 'admin-token');
const expectedAdmin = 'test-admin-token';
await writeFile(adminFile, `${expectedAdmin}\n`);
const calls = [];

const sidecar = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://sidecar.test');
  let body = '';
  for await (const chunk of req) body += chunk;
  calls.push({
    method: req.method,
    path: `${url.pathname}${url.search}`,
    authorization: req.headers.authorization || '',
    accept: req.headers.accept || '',
    forwardedHost: req.headers['x-forwarded-host'] || '',
    forwardedPrefix: req.headers['x-forwarded-prefix'] || '',
    body,
  });
  if (url.pathname === '/install.sh') {
    res.writeHead(200, { 'Content-Type': 'text/x-shellscript' });
    res.end('#!/bin/sh\n');
    return;
  }
  if (url.pathname === '/v1/devices/display-aaaaaaaaaaaaaaaa/frame.png') {
    if (req.headers.accept?.startsWith('application/vnd.remotelab.display-frames+json;v=2')) {
      const current = req.headers.accept.endsWith(';id=fedcba987654');
      if (current) { res.writeHead(304, { 'X-RemoteLab-Display-Poll-Seconds': '2' }); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/vnd.remotelab.display-frames+json', 'X-RemoteLab-Display-Poll-Seconds': '2' });
      res.end(JSON.stringify({ version: 2, frameId: '0123456789ab', bundleId: 'fedcba987654', intervalMs: 100, frames: ['/9g='] }));
      return;
    }
    if (req.headers.accept?.startsWith('application/vnd.remotelab.display-frames+json;v=1')) {
      const current = req.headers.accept.endsWith(';id=0123456789ab');
      if (current) { res.writeHead(304, { 'X-RemoteLab-Display-Poll-Seconds': '2' }); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/vnd.remotelab.display-frames+json', 'X-RemoteLab-Display-Poll-Seconds': '2' });
      res.end(JSON.stringify({ version: 1, frameId: '0123456789ab', intervalMs: 180, frames: ['/9g='] }));
      return;
    }
    const jpeg = req.headers.accept === 'image/jpeg';
    res.writeHead(200, {
      'Content-Type': jpeg ? 'image/jpeg' : 'image/png',
      'X-RemoteLab-Display-Poll-Seconds': jpeg ? '0.18' : '0.45',
    });
    res.end(jpeg ? Buffer.from([0xff, 0xd8, 0xff, 0xd9]) : Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    return;
  }
  if (url.pathname === '/v1/devices/display-aaaaaaaaaaaaaaaa/heartbeat' && req.method === 'POST') {
    json(res, 200, { accepted: JSON.parse(body).usbFrames });
    return;
  }
  if (url.pathname === '/v1/enroll/rld_enroll_test-token') {
    json(res, 201, { deviceId: 'display-aaaaaaaaaaaaaaaa' });
    return;
  }
  if (url.pathname === '/v1/enrollments') {
    if (req.headers.authorization !== `Bearer ${expectedAdmin}`) return json(res, 401, { error: 'bad admin' });
    const owner = JSON.parse(body || '{}').personId;
    json(res, 201, { command: `pair:${owner}:${req.headers['x-forwarded-host']}${req.headers['x-forwarded-prefix']}` });
    return;
  }
  if (/^\/v1\/people\/[^/]+\/content$/.test(url.pathname)) {
    if (req.headers.authorization !== `Bearer ${expectedAdmin}`) return json(res, 401, { error: 'bad admin' });
    json(res, 200, { personId: url.pathname.split('/')[3], body: body ? JSON.parse(body) : null });
    return;
  }
  if (/^\/v1\/people\/[^/]+\/feishu\/acknowledge$/.test(url.pathname) && req.method === 'POST') {
    if (req.headers.authorization !== `Bearer ${expectedAdmin}`) return json(res, 401, { error: 'bad admin' });
    json(res, 200, { connected: true, personId: url.pathname.split('/')[3] });
    return;
  }
  if (/^\/v1\/people\/[^/]+\/todos(?:\/todo_[a-f0-9]{16})?$/.test(url.pathname)) {
    if (req.headers.authorization !== `Bearer ${expectedAdmin}`) return json(res, 401, { error: 'bad admin' });
    json(res, req.method === 'POST' ? 201 : 200, { personId: url.pathname.split('/')[3], body: body ? JSON.parse(body) : null });
    return;
  }
  if (url.pathname === '/v1/devices' && req.method === 'GET') {
    if (req.headers.authorization !== `Bearer ${expectedAdmin}`) return json(res, 401, { error: 'bad admin' });
    json(res, 200, { devices: [{ id: `display-${url.searchParams.get('personId')}` }] });
    return;
  }
  if (/^\/v1\/devices\/display-[a-f0-9]{16}$/.test(url.pathname) && req.method === 'DELETE') {
    json(res, 200, { ok: true, personId: url.searchParams.get('personId') });
    return;
  }
  json(res, 404, { error: 'not found' });
});

const sidecarPort = await listen(sidecar);
process.env.REMOTELAB_DISPLAY_INTERNAL_BASE_URL = `http://127.0.0.1:${sidecarPort}`;
process.env.REMOTELAB_DISPLAY_ADMIN_TOKEN_FILE = adminFile;
process.env.REMOTELAB_CONFIG_DIR = root;
const previewTokenFile = join(root, 'preview-token');
await writeFile(previewTokenFile, 'preview-secret\n');
let previewCall = null;
let previewDeleteCall = null;
const previewServer = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  if (!['Bearer preview-secret', `Bearer ${'a'.repeat(64)}`].includes(req.headers.authorization)) {
    json(res, 401, { error: 'bad preview token' }); return;
  }
  if (req.method === 'DELETE') {
    previewDeleteCall = { authorization: req.headers.authorization, personId: req.headers['x-preview-person-id'] };
    json(res, 200, { ok: true, configured: false });
    return;
  }
  previewCall = { authorization: req.headers.authorization, personId: req.headers['x-preview-person-id'], body };
  json(res, 200, req.method === 'GET' ? { devices: [{ name: 'Test display' }] } : { ok: true, frameId: 'sample-frame' });
});
const previewPort = await listen(previewServer);
process.env.REMOTELAB_DISPLAY_STUDIO_PREVIEW_BASE_URL = `http://127.0.0.1:${previewPort}`;
process.env.REMOTELAB_DISPLAY_STUDIO_PREVIEW_TOKEN_FILE = previewTokenFile;
process.env.REMOTELAB_DISPLAY_STUDIO_PREVIEW_PERSON_ID = 'person-a';

const main = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://main.test').pathname;
  if (await handleDisplayPublicRoutes({ req, res, pathname, writeJson: json })) return;
  const personId = req.headers['x-test-person'];
  if (!personId) return json(res, 401, { error: 'auth required' });
  if (await handleDisplaySettingsRoutes({
    req,
    res,
    pathname,
    authSession: { personId },
    writeJson: json,
  })) return;
  json(res, 404, { error: 'not found' });
});

const mainPort = await listen(main);
const base = `http://127.0.0.1:${mainPort}`;

try {
  const installer = await requestJson(`${base}/display/install.sh`);
  assert.equal(installer.response.status, 200);
  assert.equal(installer.text, '#!/bin/sh\n');

  const publicEnrollment = await requestJson(`${base}/display/v1/enroll/rld_enroll_test-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(publicEnrollment.response.status, 201);

  const negotiatedFrame = await fetch(`${base}/display/v1/devices/display-aaaaaaaaaaaaaaaa/frame.png`, {
    headers: { Authorization: 'Bearer device-secret', Accept: 'image/jpeg' },
  });
  assert.equal(negotiatedFrame.status, 200);
  assert.equal(negotiatedFrame.headers.get('content-type'), 'image/jpeg');
  assert.equal(negotiatedFrame.headers.get('x-remotelab-display-poll-seconds'), '0.18');
  assert.deepEqual([...Buffer.from(await negotiatedFrame.arrayBuffer())], [0xff, 0xd8, 0xff, 0xd9]);
  assert.deepEqual(calls.find((call) => call.path.endsWith('/frame.png'))?.accept, 'image/jpeg');
  const bundleAccept = 'application/vnd.remotelab.display-frames+json;v=1';
  const proxiedBundle = await fetch(`${base}/display/v1/devices/display-aaaaaaaaaaaaaaaa/frame.png`, {
    headers: { Authorization: 'Bearer device-secret', Accept: bundleAccept },
  });
  assert.equal(proxiedBundle.status, 200);
  assert.equal(proxiedBundle.headers.get('content-type'), 'application/vnd.remotelab.display-frames+json');
  assert.equal((await proxiedBundle.json()).frameId, '0123456789ab');
  const currentBundle = await fetch(`${base}/display/v1/devices/display-aaaaaaaaaaaaaaaa/frame.png`, {
    headers: { Authorization: 'Bearer device-secret', Accept: `${bundleAccept};id=0123456789ab` },
  });
  assert.equal(currentBundle.status, 304);
  assert.equal(currentBundle.headers.get('x-remotelab-display-poll-seconds'), '2');
  const fasterBundle = await fetch(`${base}/display/v1/devices/display-aaaaaaaaaaaaaaaa/frame.png`, {
    headers: { Authorization: 'Bearer device-secret', Accept: bundleAccept.replace('v=1', 'v=2') },
  });
  assert.equal(fasterBundle.status, 200);
  assert.equal((await fasterBundle.json()).intervalMs, 100);
  const currentFasterBundle = await fetch(`${base}/display/v1/devices/display-aaaaaaaaaaaaaaaa/frame.png`, {
    headers: { Authorization: 'Bearer device-secret', Accept: `${bundleAccept.replace('v=1', 'v=2')};id=fedcba987654` },
  });
  assert.equal(currentFasterBundle.status, 304);
  const playbackReport = await requestJson(`${base}/display/v1/devices/display-aaaaaaaaaaaaaaaa/heartbeat`, {
    method: 'POST', headers: { Authorization: 'Bearer device-secret', 'Content-Type': 'application/json' },
    body: JSON.stringify({ usbFrames: 42 }),
  });
  assert.equal(playbackReport.payload.accepted, 42);
  assert.equal(calls.find((call) => call.path.endsWith('/heartbeat'))?.authorization, 'Bearer device-secret');

  const denied = await requestJson(`${base}/api/display/devices`);
  assert.equal(denied.response.status, 401);

  const personA = await requestJson(`${base}/api/display/devices`, { headers: { 'X-Test-Person': 'aaaaaaaaaaaaaaaa' } });
  assert.equal(personA.response.status, 200);
  assert.equal(personA.payload.devices[0].id, 'display-aaaaaaaaaaaaaaaa');

  const personB = await requestJson(`${base}/api/display/devices`, { headers: { 'X-Test-Person': 'bbbbbbbbbbbbbbbb' } });
  assert.equal(personB.response.status, 200);
  assert.equal(personB.payload.devices[0].id, 'display-bbbbbbbbbbbbbbbb');

  const enrollment = await requestJson(`${base}/api/display/enrollments`, {
    method: 'POST',
    headers: {
      'X-Test-Person': 'person-a',
      'X-Forwarded-Proto': 'https',
      'X-Forwarded-Host': 'alice.remotelab.example',
    },
  });
  assert.equal(enrollment.response.status, 201);
  assert.equal(enrollment.payload.command, 'pair:person-a:alice.remotelab.example/display');

  const removed = await requestJson(`${base}/api/display/devices/display-aaaaaaaaaaaaaaaa`, {
    method: 'DELETE',
    headers: { 'X-Test-Person': 'person-a' },
  });
  assert.equal(removed.response.status, 200);
  assert.equal(removed.payload.personId, 'person-a');

  const content = await requestJson(`${base}/api/display/content`, {
    method: 'PUT',
    headers: { 'X-Test-Person': 'person-a', 'Content-Type': 'application/json' },
    body: JSON.stringify({ sentence: 'hello', gifBase64: 'R0lG', personId: 'person-b' }),
  });
  assert.equal(content.response.status, 200);
  assert.equal(content.payload.personId, 'person-a');
  assert.deepEqual(content.payload.body, { sentence: 'hello', gifBase64: 'R0lG' }, 'client cannot select another person');
  const other = await requestJson(`${base}/api/display/content`, { headers: { 'X-Test-Person': 'person-b' } });
  assert.equal(other.payload.personId, 'person-b');

  const deniedAck = await requestJson(`${base}/api/display/feishu/acknowledge`, {
    method: 'POST', headers: { Origin: 'https://unrelated.example', 'X-Test-Person': 'person-a' },
  });
  assert.equal(deniedAck.response.status, 403);
  const acknowledged = await requestJson(`${base}/api/display/feishu/acknowledge`, {
    method: 'POST', headers: { Origin: base, 'X-Test-Person': 'person-a', 'Content-Type': 'application/json' },
    body: JSON.stringify({ observedAt: '2026-09-25T09:00:00.000Z' }),
  });
  assert.equal(acknowledged.response.status, 200);
  assert.equal(acknowledged.payload.personId, 'person-a');
  assert.deepEqual(JSON.parse(calls.find((call) => call.path === '/v1/people/person-a/feishu/acknowledge').body), { observedAt: '2026-09-25T09:00:00.000Z' });

  const deniedTodo = await requestJson(`${base}/api/display/todos`, {
    method: 'POST', headers: { Origin: 'https://unrelated.example', 'X-Test-Person': 'person-a', 'Content-Type': 'application/json' }, body: '{"title":"筛选候选人"}',
  });
  assert.equal(deniedTodo.response.status, 403);
  const createdTodo = await requestJson(`${base}/api/display/todos`, {
    method: 'POST', headers: { Origin: base, 'X-Test-Person': 'person-a', 'Content-Type': 'application/json' }, body: '{"title":"筛选候选人"}',
  });
  assert.equal(createdTodo.response.status, 201);
  assert.equal(createdTodo.payload.personId, 'person-a');
  const changedTodo = await requestJson(`${base}/api/display/todos/todo_aaaaaaaaaaaaaaaa`, {
    method: 'PATCH', headers: { Origin: base, 'X-Test-Person': 'person-b', 'Content-Type': 'application/json' }, body: '{"status":"done"}',
  });
  assert.equal(changedTodo.payload.personId, 'person-b', 'the URL never chooses another Person');

  const deniedStudio = await requestJson(`${base}/api/display/studio-preview`, {
    method: 'POST', headers: { Origin: 'https://unrelated.example', 'X-Test-Person': 'person-a', 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(deniedStudio.response.status, 403);
  const studio = await requestJson(`${base}/api/display/studio-preview`, {
    method: 'POST', headers: { Origin: base, 'X-Test-Person': 'person-a', 'Content-Type': 'application/json' }, body: '{"version":14}',
  });
  assert.equal(studio.response.status, 200);
  assert.equal(studio.payload.frameId, 'sample-frame');
  assert.deepEqual(previewCall, { authorization: 'Bearer preview-secret', personId: 'person-a', body: '{"version":14}' });
  const deniedStudioDelete = await requestJson(`${base}/api/display/studio-preview`, { method: 'DELETE' });
  assert.equal(deniedStudioDelete.response.status, 401);
  const otherPersonDelete = await requestJson(`${base}/api/display/studio-preview`, { method: 'DELETE', headers: { 'X-Test-Person': 'person-b' } });
  assert.equal(otherPersonDelete.response.status, 200);
  assert.equal(previewDeleteCall, null, 'another Person cannot stop this paired studio');
  const studioDelete = await requestJson(`${base}/api/display/studio-preview`, { method: 'DELETE', headers: { 'X-Test-Person': 'person-a' } });
  assert.equal(studioDelete.response.status, 200);
  assert.deepEqual(previewDeleteCall, { authorization: 'Bearer preview-secret', personId: 'person-a' });
  const privateToken = 'a'.repeat(64);
  const deniedPublicStudio = await requestJson(`${base}/display/studio-preview`, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(deniedPublicStudio.response.status, 401);
  const publicStatus = await requestJson(`${base}/display/studio-preview/status`, { headers: { Authorization: `Bearer ${privateToken}` } });
  assert.equal(publicStatus.response.status, 200);
  assert.deepEqual(publicStatus.payload.devices, [{ name: 'Test display' }]);
  const publicStudio = await requestJson(`${base}/display/studio-preview`, {
    method: 'POST', headers: { Origin: base, Authorization: `Bearer ${privateToken}`, 'Content-Type': 'application/json' }, body: '{"version":14}',
  });
  assert.equal(publicStudio.response.status, 200);
  assert.deepEqual(previewCall, { authorization: `Bearer ${privateToken}`, personId: 'person-a', body: '{"version":14}' });

  const anonymousTheme = await requestJson(`${base}/api/display/theme-selection`, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{"theme":"mist"}',
  });
  assert.equal(anonymousTheme.response.status, 401);
  const wrongOriginTheme = await requestJson(`${base}/api/display/theme-selection`, {
    method: 'POST', headers: { Origin: 'https://unrelated.example', 'X-Test-Person': 'person-a' }, body: '{"theme":"mist"}',
  });
  assert.equal(wrongOriginTheme.response.status, 403);
  const invalidTheme = await requestJson(`${base}/api/display/theme-selection`, {
    method: 'POST', headers: { Origin: base, 'X-Test-Person': 'person-a' }, body: '{"theme":"invented"}',
  });
  assert.equal(invalidTheme.response.status, 400);
  const selected = await requestJson(`${base}/api/display/theme-selection`, {
    method: 'POST', headers: { Origin: base, 'X-Test-Person': 'person-a' }, body: '{"theme":"mist"}',
  });
  assert.equal(selected.response.status, 202);
  const publicDeniedTheme = await requestJson(`${base}/display/theme-selection`, {
    method: 'POST', headers: { Origin: base, Authorization: `Bearer ${'b'.repeat(64)}` }, body: '{"theme":"rose"}',
  });
  assert.equal(publicDeniedTheme.response.status, 401);
  const publicSelected = await requestJson(`${base}/display/theme-selection`, {
    method: 'POST', headers: { Origin: base, Authorization: `Bearer ${privateToken}` }, body: '{"theme":"rose"}',
  });
  assert.equal(publicSelected.response.status, 202);
  const appliedPayload = JSON.stringify({ version: 21, state: { theme: 'midnight' } });
  const applied = await requestJson(`${base}/api/display/studio-preview`, {
    method: 'POST', headers: { Origin: base, 'X-Test-Person': 'person-a' }, body: appliedPayload,
  });
  assert.equal(applied.response.status, 200);
  const publicApplied = await requestJson(`${base}/display/studio-preview`, {
    method: 'POST', headers: { Origin: base, Authorization: `Bearer ${privateToken}` }, body: appliedPayload,
  });
  assert.equal(publicApplied.response.status, 200);
  const themeFile = join(root, 'display-theme-events.jsonl');
  const themeEvents = (await readFile(themeFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(themeEvents.map(({ action, theme }) => [action, theme]), [
    ['selected', 'mist'], ['selected', 'rose'], ['applied', 'midnight'], ['applied', 'midnight'],
  ]);
  assert.equal(new Set(themeEvents.map((event) => event.personHash)).size, 1);
  assert(!JSON.stringify(themeEvents).includes('person-a'), 'analytics excludes raw Person IDs and editor payloads');
  assert.equal((await stat(themeFile)).mode & 0o777, 0o600);

  assert.equal(calls.find((call) => call.path === '/install.sh').authorization, '');
  assert.equal(calls.find((call) => call.path === '/v1/enrollments').body, JSON.stringify({ personId: 'person-a' }));
  assert(calls.filter((call) => call.path.startsWith('/v1/devices?')).every(
    (call) => call.authorization === `Bearer ${expectedAdmin}`,
  ));
  console.log('ok - main Settings routes bind display operations to the authenticated person');
} finally {
  await Promise.all([
    new Promise((resolve) => main.close(resolve)),
    new Promise((resolve) => sidecar.close(resolve)),
    new Promise((resolve) => previewServer.close(resolve)),
  ]);
  await rm(root, { recursive: true, force: true });
}
