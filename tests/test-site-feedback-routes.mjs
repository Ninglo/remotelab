#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const root = await mkdtemp(join(tmpdir(), 'remotelab-site-feedback-'));
process.env.REMOTELAB_CONFIG_DIR = root;
const { handleSiteFeedbackRoutes } = await import('../chat/router-site-feedback-routes.mjs');

function request(method, payload, headers = {}, personId = 'person_test') {
  const req = Readable.from(payload === undefined ? [] : [JSON.stringify(payload)]);
  req.method = method;
  req.socket = { encrypted: false };
  req.headers = {
    host: 'example.test', origin: 'http://example.test',
    'content-type': 'application/json', ...headers,
  };
  let result;
  return handleSiteFeedbackRoutes({
    req, res: {}, pathname: '/api/site-feedback', authSession: personId ? { personId } : null,
    writeJson: (_res, status, data) => { result = { status, data }; },
  }).then((handled) => { assert.equal(handled, true); return result; });
}

try {
  const payload = {
    client_id: '123e4567-e89b-42d3-a456-426614174000',
    target: { kind: 'source', id: 'x:123', title: '测试文章', url: 'https://example.test/article', revision: 'content-v1' },
    display_version: 'daily-v1',
    scores: { priority: 5, relevance: 4, novelty: null },
    next_step: 'read', tags: ['valuable-source'], comment: '值得继续看', evidence_url: '',
  };
  const first = await request('POST', payload);
  assert.equal(first.status, 201);
  assert.match(first.data.id, /^fb_/);
  assert.equal(first.data.duplicate, false);

  const repeat = await request('POST', payload);
  assert.equal(repeat.status, 200);
  assert.equal(repeat.data.id, first.data.id);
  assert.equal(repeat.data.duplicate, true);

  const conflicting = await request('POST', { ...payload, comment: '改过的内容' });
  assert.equal(conflicting.status, 409);

  const list = await request('GET');
  assert.equal(list.status, 200);
  assert.equal(list.data.feedback.length, 1);
  assert.equal(list.data.feedback[0].scores.priority, 5);
  assert.equal(list.data.feedback[0].person_id, 'person_test');
  assert.equal(list.data.feedback[0].target.revision, 'content-v1');
  assert.equal(list.data.feedback[0].display_version, 'daily-v1');
  assert.equal((await request('GET', undefined, {}, 'person_other')).data.feedback.length, 0);

  const quick = {
    ...payload,
    client_id: '123e4567-e89b-42d3-a456-426614174001',
    scores: { priority: null, relevance: null, novelty: null },
    usefulness: 'useful', next_step: '', tags: [], comment: '',
  };
  assert.equal((await request('POST', quick)).status, 201);
  const changed = {
    ...quick, client_id: '123e4567-e89b-42d3-a456-426614174002',
    usefulness: 'not_useful',
  };
  assert.equal((await request('POST', changed)).status, 201);
  const latest = await request('GET');
  assert.equal(latest.data.quick_state['source:x:123'].usefulness, 'not_useful');
  assert.equal(latest.data.quick_state['source:x:123'].revision, 'content-v1');
  assert.equal(latest.data.quick_state['source:x:123'].display_version, 'daily-v1');
  assert.equal(latest.data.feedback.length, 3);
  assert.equal((await request('GET', undefined, {}, 'person_other')).data.quick_state['source:x:123'], undefined);

  assert.equal((await request('POST', payload, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await request('POST', payload, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await request('POST', { ...payload, scores: { priority: 6 } })).status, 400);
  assert.equal((await request('POST', { ...quick, client_id: '123e4567-e89b-42d3-a456-426614174003', usefulness: 'like' })).status, 400);
  assert.equal((await request('POST', payload, {}, null)).status, 403);
  const files = await readdir(join(root, 'site-feedback', 'qianyan-workbench'));
  assert.equal(files.filter((name) => name.endsWith('.json')).length, 3);
  console.log('site feedback route: detailed and quick save, readback, latest state, idempotency, isolation, validation OK');
} finally {
  await rm(root, { recursive: true, force: true });
}
