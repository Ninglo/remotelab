import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createProjectFeedbackStore } from '../chat/project-feedback.mjs';
import { createProjectFeedbackHandler } from '../chat/router-project-feedback-routes.mjs';

const root = await mkdtemp(join(tmpdir(), 'project-feedback-'));
const configFile = join(root, 'board.json'), writeDir = join(root, 'web');
const legacyFile = join(root, 'legacy.json'), reviewFile = join(root, 'review.json'), qianyanFile = join(root, 'qianyan.json');
const json = (path, body) => writeFile(path, JSON.stringify(body));
const legacy = { records: [
  { id: 'a', actor: { name: 'Reviewer A', openId: 'private-provider-id' }, observedText: '<img src=x onerror=alert(1)>',
    source: { quote: 'Evaluated passage', url: 'https://example.test/doc' }, eventTime: 1234, state: 'reviewed',
    interpretation: { assessment: 'Needs a clearer current result.' } },
  { id: 'b', observedText: 'Proceed', source: { url: 'javascript:alert(1)' } },
  { id: 'c', observedText: 'Paused device' }, { id: 'd', observedText: 'Ownership unknown' },
] };
const review = { created_at: '2026-10-10T12:00:00Z',
  subprojects: [{ subproject_id: 'reports', name: 'Reports', suggested_directions: ['Show the current result.'] },
    { subproject_id: 'recording', name: 'Recording', suggested_directions: [] }],
  themes: [{ id: 'theme', subproject_id: 'reports', title: 'Current result', suggested_direction: 'Show the result first.' }],
  classifications: [
    { source_record_id: 'a', bucket: 'assigned_feedback', primary_subproject_id: 'reports', theme_id: 'theme', reason: 'Evaluates the report.' },
    { source_record_id: 'b', bucket: 'related_context' }, { source_record_id: 'c', bucket: 'paused_history' },
    { source_record_id: 'd', bucket: 'unassigned_feedback', pending_candidate: 'Access' },
    { source_record_id: 'vote', bucket: 'assigned_feedback', primary_subproject_id: 'reports' },
  ],
};
try {
  await json(legacyFile, legacy); await json(reviewFile, review);
  const vote = { id: 'vote', author: { name: 'Reviewer B', id: 'person_b' }, target: { title: 'Paper', revision: 'v1' }, usefulness: 'useful', created_at: '2026-10-10T12:01:00Z' };
  await json(qianyanFile, { stage_feedback: [vote], selection_feedback: [vote], analysis_feedback: [], feedback_reviews: [{ feedback_id: 'vote', status: 'reviewed', reason: 'Preserve the signal; no policy change.' }] });
  await json(configFile, { legacyFile, reviewFile, qianyanFile, writeDir });
  const originals = await Promise.all([legacyFile, reviewFile, qianyanFile].map(p => readFile(p, 'utf8')));
  const store = createProjectFeedbackStore({ configFile });
  const overview = await store.read();
  assert.deepEqual(overview.counts, { unassigned_feedback: 1, related_context: 1, paused_history: 1, assigned_feedback: 2, raw_records: 5 });
  assert.equal(overview.projects[1].coverage, 'not_represented');
  assert.equal(overview.projects[1].current_unresolved_count, null);
  assert.equal(overview.projects[0].themes[0].change_state, 'suggested');
  const reports = await store.read('reports');
  assert.equal(reports.records.length, 2);
  assert.equal(reports.records.find(r => r.id === 'vote').review_state, 'reviewed');
  assert.equal(reports.records.find(r => r.id === 'vote').analysis, 'Preserve the signal; no policy change.');
  assert.equal(reports.records.find(r => r.id === 'a').target_quote, 'Evaluated passage');
  assert.equal(reports.records.find(r => r.id === 'a').change_state, 'unknown');
  assert(!JSON.stringify(reports).includes('private-provider-id'));
  assert.equal((await store.read('related_context')).records[0].source_url, '');
  await assert.rejects(() => store.read('missing'), { code: 'NOT_FOUND' });
  const actor = { person_id: 'person_a', name: 'Reviewer A', identity_id: 'identity_a' };
  const payload = { client_id: '123e4567-e89b-42d3-a456-426614174000', subproject_id: 'reports',
    comment: 'Put the decision first.', example: 'Current: history first. Expected: decision first.',
    usefulness: '', target_title: 'Report v2', target_url: 'https://example.test/report', related_feedback_id: 'a' };
  const concurrent = await Promise.all(Array.from({ length: 6 }, () => store.submit(actor, payload)));
  assert.equal(new Set(concurrent.map(x => x.record.id)).size, 1);
  assert.equal(concurrent.filter(x => !x.duplicate).length, 1);
  await assert.rejects(() => store.submit(actor, { ...payload, comment: 'Changed draft' }), { code: 'FEEDBACK_CONFLICT' });
  const fresh = createProjectFeedbackStore({ configFile });
  const afterRestart = await fresh.read();
  assert.equal(afterRestart.projects[0].feedback_count, 3);
  assert.equal(afterRestart.projects[0].pending_analysis_count, 1);
  const written = (await fresh.read('reports')).records.find(r => r.kind === 'monitor_feedback');
  assert.equal(written.author, 'Reviewer A'); assert.equal(written.related_feedback_id, 'a');
  assert.equal(written.example, payload.example); assert.equal(written.review_state, 'collected');
  review.classifications.push({ source_record_id: written.id, primary_subproject_id: 'reports', bucket: 'assigned_feedback', theme_id: 'theme', analysis: 'Reviewed the concrete example.' });
  await json(reviewFile, review);
  assert.equal((await fresh.read()).projects[0].pending_analysis_count, 0);
  await writeFile(reviewFile, originals[1]);
  const quick = { client_id: '123e4567-e89b-42d3-a456-426614174001', subproject_id: 'recording', usefulness: 'not_useful' };
  assert.equal((await fresh.submit(actor, quick)).record.usefulness, 'not_useful');
  for (const input of [ { ...quick, usefulness: 'approved' }, { ...quick, target_url: 'javascript:alert(1)' },
    { ...quick, subproject_id: 'missing' }, { ...quick, comment: 'x'.repeat(4001) },
    { ...quick, related_feedback_id: 'c' }, { ...quick, related_feedback_id: 'missing' },
    { ...quick, usefulness: '' } ]) await assert.rejects(() => fresh.submit(actor, input), { code: 'INVALID_INPUT' });
  const files = await readdir(writeDir);
  assert.equal(files.length, 2); assert.equal((await stat(writeDir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(writeDir, files[0]))).mode & 0o777, 0o600);
  assert.deepEqual(await Promise.all([legacyFile, reviewFile, qianyanFile].map(p => readFile(p, 'utf8'))), originals);
  await writeFile(qianyanFile, '{broken');
  assert.equal((await fresh.read()).gaps[0].source, 'qianyanFile');
  await writeFile(qianyanFile, originals[2]);
  const noConfig = createProjectFeedbackStore({ configFile: join(root, 'none') });
  assert.equal((await noConfig.read()).configured, false);
  await assert.rejects(() => noConfig.submit(actor, quick), { code: 'NOT_CONFIGURED' });
  const handle = createProjectFeedbackHandler({ store: fresh, personLookup: async id => ({ id, name: 'Verified name' }) });
  async function route(method, body, headers = {}, person = 'person_test', url = '/api/project-feedback') {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
    req.method = method; req.url = url; req.socket = {};
    req.headers = { host: 'example.test', origin: 'http://example.test', 'content-type': 'application/json', ...headers };
    let result; const responseHeaders = {};
    const handled = await handle({ req, res: { setHeader: (k, v) => responseHeaders[k] = v }, pathname: '/api/project-feedback',
      authSession: person ? { personId: person } : null, writeJson: (_res, status, data) => result = { status, data } });
    assert(handled); assert.equal(responseHeaders['Cache-Control'], 'private, no-store'); return result;
  }
  assert.equal((await route('GET', undefined, {}, null)).status, 403);
  assert.equal((await route('GET', undefined, {}, 'person_other')).data.counts.raw_records, 7, 'instance is shared among authenticated People');
  assert.equal((await route('POST', quick, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await route('POST', quick, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await route('POST', quick, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await route('DELETE')).status, 405);
  assert.equal((await route('GET', undefined, {}, 'person_test', '/api/project-feedback?subproject=missing')).status, 404);
  const result = await route('POST', { ...quick, actor: { name: 'Spoofed' } });
  assert.equal(result.status, 201); assert.equal(result.data.record.author, 'Verified name');
  assert.equal((await route('POST', quick)).status, 200);
  assert.equal((await route('POST', { ...quick, usefulness: 'useful' })).status, 409);
  console.log('Project feedback: source identity, deduplication, classification, gaps, durable writes, attribution, concurrency, validation and authenticated routes passed.');
} finally { await rm(root, { recursive: true, force: true }); }
