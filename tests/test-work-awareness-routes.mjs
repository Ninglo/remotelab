import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'remotelab-work-routes-'));
setIsolatedTestHome(home);
const config = join(home, '.config', 'remotelab');
await mkdir(config, { recursive: true });
await writeFile(join(config, 'auth.json'), JSON.stringify({ version: 2, primaryPersonId: 'person_a', people: [
  { id: 'person_a', name: '甲', identities: [{ id: 'identity_a', kind: 'web', subjectId: 'a' }] },
  { id: 'person_b', name: '乙', identities: [{ id: 'identity_b', kind: 'web', subjectId: 'b' }] },
] }));
await writeFile(join(config, 'chat-sessions.json'), JSON.stringify([{ id: 'a', name: 'a', folder: home }, { id: 'b', name: 'b', folder: home }]));
try {
  await (await import('../lib/auth-config.mjs')).loadAuthDocument({ persistMigration: false });
  const { handleWorkAwarenessRoutes } = await import('../chat/router-work-awareness.mjs');
  const { requests } = await import('../chat/requests.mjs');
  const { appendEvent } = await import('../chat/history.mjs');
  const { runWorkAwarenessCommand } = await import('../lib/work-awareness-command.mjs');
  const { record } = await requests.accept({ sessionId: 'a', requestId: 'human', text: '修改 Session 开工功能',
    options: { viewPersonId: 'person_a', initiatedByIdentityId: 'identity_a', sourceContext: null } });
  const event = await appendEvent('a', { type: 'message', role: 'user', content: record.text });
  async function call(path, body, auth = { authKind: 'service' }) {
    let output;
    const parsedUrl = new URL(path, 'http://test');
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    req.method = body ? 'POST' : 'GET';
    const matched = await handleWorkAwarenessRoutes({ req, res: {}, pathname: parsedUrl.pathname, parsedUrl, authSession: auth,
      writeJson(res, status, json) { output = { status, json }; } });
    assert.equal(matched, true);
    return output;
  }
  const webPeople = await call('/api/work-awareness/people?runId=' + record.runId);
  assert.equal(webPeople.status, 200); assert.match(webPeople.json.context, /person_a/);
  assert.equal((await call('/api/work-awareness/start?sessionId=a', { runId: 'unregistered', goal: 'unknown' })).status, 403);
  assert.equal((await call('/api/work-awareness/start', { runId: record.runId, goal: 'wrong actor' }, { authKind: 'web', personId: 'person_b' })).status, 403);
  const started = await call('/api/work-awareness/start', { runId: record.runId, goal: record.text, actor: { personId: 'person_b' }, evidenceRefs: [event.seq] });
  assert.equal(started.status, 200); assert.equal(started.json.work.actor.personId, 'person_a', 'body cannot replace Request attribution');
  const work = started.json.work;
  assert.equal((await call('/api/work-awareness/update', { runId: record.runId, workId: work.id, expectedVersion: 1, status: 'completed', result: 'unproven', evidenceRefs: [9999] })).status, 400);
  const updated = await call('/api/work-awareness/update', { runId: record.runId, workId: work.id, expectedVersion: 1, status: 'completed', result: 'source-backed report', evidenceRefs: [event.seq] });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.work.results[0].acceptance, 'reported-with-source-evidence');
  const suggested = await call('/api/work-awareness/suggest', { runId: record.runId, targetSessionId: 'b',
    content: '参考建议', impact: '核对是否重复', evidenceRefs: [event.seq] });
  assert.equal(suggested.status, 200); assert.equal(suggested.json.suggestion.state, 'draft');
  assert.equal((await call('/api/work-awareness?sessionId=b&includeBackground=false')).json.suggestions.length, 0);
  const route = await call('/api/work-awareness/suggest', { runId: record.runId, purpose: 'routing', content: '建议新开一个独立 Session',
    impact: '执行目的地将改变，需人工核验', evidenceRefs: [event.seq], routing: { mode: 'new-session', task: '调查限定的第二条路线', folder: home, name: '参考草稿' } });
  assert.equal(route.status, 200); assert.equal(route.json.suggestion.targetSessionId, '');
  assert.equal(route.json.suggestion.state, 'draft');
  const current = await call('/api/work-awareness?sessionId=a&includeBackground=false');
  assert.equal(current.status, 200); assert.equal(current.json.background, undefined);
  let commandRequest, output = '';
  await runWorkAwarenessCommand(['context', '--session', 'a', '--query', '开工功能', '--json'], {
    stdout: { write(value) { output += value; } }, client: { async request(path, options) {
      commandRequest = { path, options }; return { response: { ok: true }, json: current.json };
    } },
  });
  assert.match(commandRequest.path, /sessionId=a/); assert.equal(JSON.parse(output).sessionId, 'a');
  await assert.rejects(runWorkAwarenessCommand(['approve']), /Use work/);
  console.log('WORK_ROUTES_VERIFIED: accepted Request attribution; missing/wrong actor rejected; fabricated evidence rejected; Agent drafts cannot approve; routing stays a reviewed packet; CLI shares the same read entry.');
} finally { await rm(home, { recursive: true, force: true }); }
