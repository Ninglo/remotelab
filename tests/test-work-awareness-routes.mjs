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
await writeFile(join(config, 'chat-sessions.json'), JSON.stringify([{ id: 'a', name: 'a', folder: home },
  { id: 'b', name: 'b', folder: home, workSummary: { goal: '实现 Session 开工登记和相关工作检索' } }]));
try {
  await (await import('../lib/auth-config.mjs')).loadAuthDocument({ persistMigration: false });
  const { handleWorkAwarenessRoutes } = await import('../chat/router-work-awareness.mjs');
  const { requests } = await import('../chat/requests.mjs');
  const { appendEvent } = await import('../chat/history.mjs');
  const { runWorkAwarenessCommand } = await import('../lib/work-awareness-command.mjs');
  const { record } = await requests.accept({ sessionId: 'a', requestId: 'human', text: '修改 Session 开工功能',
    options: { viewPersonId: 'person_a', initiatedByIdentityId: 'identity_a', sourceContext: null } });
  const event = await appendEvent('a', { type: 'message', role: 'user', content: record.text });
  const { recordWorkInput } = await import('../chat/work-awareness.mjs');
  const { findSessionMeta } = await import('../chat/session-meta-store.mjs');
  await recordWorkInput(await findSessionMeta('a'), record);
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
  const search = await call('/api/work-awareness?sessionId=a&query=' + encodeURIComponent(record.text) + '&includeBackground=false');
  assert.equal(search.json.related.length, 0, 'word matching is not a displayed recommendation');
  const candidate = search.json.candidates.find(item => item.sessionId === 'b');
  assert(candidate, 'existing work summaries are retrievable');
  const review = { runId: record.runId, items: [{ sessionId: 'b', workId: candidate.id, fingerprint: candidate.fingerprint,
    relation: 'reuse', reason: '另一会话已有开工检索实现，可作为本轮修改相同功能的来源。' }], evidenceRefs: [event.seq] };
  assert.equal((await call('/api/work-awareness/review', { ...review, evidenceRefs: [9999] })).status, 400);
  assert.equal((await call('/api/work-awareness/review', review, { authKind: 'web', personId: 'person_b' })).status, 403);
  assert.equal((await call('/api/work-awareness/review', review)).status, 200);
  const relatedSource = (await call('/api/work-awareness?sessionId=a&includeBackground=false')).json.related[0];
  assert.equal(relatedSource.verification, 'harness-reviewed');
  assert.equal(relatedSource.sourceInfo.verified, false, 'legacy summaries do not invent an original message');
  assert.equal(relatedSource.sourceInfo.receivedAt, '');
  assert.equal(relatedSource.sessionLocation, relatedSource.sourceInfo.location, 'existing read consumers retain the location field');
  const { describeRelatedWorkSource } = await import('../chat/work-suggestion-description.mjs');
  const workSource = await describeRelatedWorkSource({ ...work, sessionId: 'a' }, [await findSessionMeta('a')]);
  assert.equal(workSource.location, 'Web 对话');
  assert.equal(workSource.actorName, '甲');
  assert.equal(workSource.receivedAt, record.acceptedAt);
  assert.equal((await call('/api/work-awareness/update', { runId: record.runId, workId: work.id, expectedVersion: 1, status: 'completed', result: 'unproven', evidenceRefs: [9999] })).status, 400);
  const updated = await call('/api/work-awareness/update', { runId: record.runId, workId: work.id, expectedVersion: 1, status: 'completed', result: 'source-backed report', evidenceRefs: [event.seq] });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.work.results[0].acceptance, 'reported-with-source-evidence');
  const suggested = await call('/api/work-awareness/suggest', { runId: record.runId, targetSessionId: 'b',
    content: '参考建议', impact: '核对是否重复', evidenceRefs: [event.seq] });
  assert.equal(suggested.status, 200); assert.equal(suggested.json.suggestion.state, 'draft');
  assert.equal((await call('/api/work-awareness?sessionId=b&includeBackground=false')).json.suggestions.length, 0);
  const explanation = { summary: '另一边正在修改同一个入口，测试发现两处改动可能影响同一回复。',
    relevance: '双方的任务都涉及开工时读取资料，因此需要一起核对改动。', nextAction: '先核对另一边的最新实现，再决定是否把这条发现同步过去。' };
  const described = await call('/api/work-awareness?sessionId=a&includeBackground=false');
  const view = described.json.suggestions.find(item => item.id === suggested.json.suggestion.id);
  assert.equal(view.sourceInfo.location, 'Web 对话');
  assert.equal(view.sourceInfo.receivedAt, record.acceptedAt);
  assert.equal(view.sourceInfo.actorName, '甲');
  assert.equal(view.sourceInfo.excerpt, record.text);
  assert.equal(view.draftedAt, suggested.json.suggestion.createdAt);
  assert.equal(view.current, true);
  assert.equal((await call('/api/work-awareness/suggest', { runId: record.runId, targetSessionId: 'b',
    content: 'technical details '.repeat(30), impact: '说明影响', evidenceRefs: [event.seq] })).status, 400);
  const explain = { runId: record.runId, suggestionId: view.id, expectedVersion: view.version,
    explanation, evidenceRefs: [event.seq], sourceRefs: [{ sessionId: 'a', requestId: record.requestId }] };
  assert.equal((await call('/api/work-awareness/explain', { ...explain, expectedVersion: 99 })).status, 409);
  assert.equal((await call('/api/work-awareness/explain', { ...explain, sourceRefs: [{ sessionId: 'a', requestId: 'fabricated' }] })).status, 400);
  const explained = await call('/api/work-awareness/explain', explain);
  assert.equal(explained.status, 200);
  assert.equal(explained.json.suggestion.content, suggested.json.suggestion.content, 'readability preserves original advice');
  assert.equal(explained.json.suggestion.state, 'draft', 'an explanation cannot publish or approve');
  assert.equal(explained.json.referenceDelivery, undefined);
  assert.equal(explained.json.suggestion.explanation.summary, explanation.summary);
  const proof = (await call('/api/work-awareness?sessionId=a&includeBackground=false')).json.suggestions.find(item => item.id === view.id);
  assert.equal(proof.references[0].excerpt, record.text);
  const { record: other } = await requests.accept({ sessionId: 'b', requestId: 'other', text: '修改另一任务',
    options: { viewPersonId: 'person_b', initiatedByIdentityId: 'identity_b', sourceContext: {
      connector: 'feishu', chatType: 'group', chatId: 'oc_example', chatName: '测试群', threadId: 'omt_example',
      createTime: '1791436400000', sender: { name: '不可信旧名字' },
    } } });
  await recordWorkInput(await findSessionMeta('b'), other);
  const otherEvidence = await appendEvent('b', { type: 'tool_result', output: 'Read the original advice' });
  assert.equal((await call('/api/work-awareness/explain', { ...explain, runId: other.runId,
    expectedVersion: explained.json.suggestion.version, evidenceRefs: [otherEvidence.seq] })).status, 403, 'another requester cannot replace its explanation');
  assert.equal((await call('/api/work-awareness?sessionId=a&includeBackground=false')).json.suggestions.find(item => item.id === view.id).current, false);
  const withSource = await call('/api/work-awareness/explain', { ...explain, expectedVersion: explained.json.suggestion.version,
    sourceRefs: [{ sessionId: 'b', requestId: other.requestId }] });
  assert.equal(withSource.status, 200);
  const external = (await call('/api/work-awareness?sessionId=a&includeBackground=false')).json.suggestions.find(item => item.id === view.id).references[0];
  assert.equal(external.location, '飞书群聊 · 测试群 · 话题');
  assert.equal(external.actorName, '乙', 'the accepted identity overrides an unverified sender label');
  assert.equal(external.messageTime, new Date(1791436400000).toISOString());
  const groupWorkSource = await describeRelatedWorkSource({ sessionId: 'b', source: { requestId: other.requestId } }, [await findSessionMeta('b')]);
  assert.equal(groupWorkSource.location, external.location);
  assert.equal(groupWorkSource.actorName, '乙');
  assert.equal(groupWorkSource.messageTime, external.messageTime);
  const { workSessionLocation } = await import('../chat/work-suggestion-description.mjs');
  assert.equal(workSessionLocation({ conversation: { connector: 'feishu', target: { chatId: 'oc_example', chatType: 'group', threadId: 'omt_example' } },
    sourceContext: { connector: 'feishu', chatId: 'oc_example', chatName: '测试群', sender: { name: '旧发言人' } } }), '飞书群聊 · 测试群 · 话题');
  assert.equal(workSessionLocation({ conversation: { connector: 'feishu', target: { chatId: 'oc_new', chatType: 'p2p' } },
    sourceContext: { connector: 'feishu', chatId: 'oc_old', chatName: '旧群' } }), '飞书私聊', 'a new binding cannot borrow the old group name');
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
