#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    forwardedHost: req.headers['x-forwarded-host'] || '',
    forwardedPrefix: req.headers['x-forwarded-prefix'] || '',
    body,
  });
  if (url.pathname === '/install.sh') {
    res.writeHead(200, { 'Content-Type': 'text/x-shellscript' });
    res.end('#!/bin/sh\n');
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
const previewTokenFile = join(root, 'preview-token');
await writeFile(previewTokenFile, 'preview-secret\n');
let previewCall = null;
const previewServer = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
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
