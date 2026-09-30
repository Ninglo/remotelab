import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'remotelab-reply-lookup-'));
process.env.HOME = home;
const history = await import('../chat/history.mjs');
const runs = await import('../chat/runs.mjs');
try {
  const sessionId = 'large-history';
  const unrelated = Array.from({ length: 1200 }, (_, n) => ({
    type: 'message', role: 'assistant', runId: `other-${n}`,
    content: 'unrelated history '.repeat(1500),
  }));
  await history.appendEvents(sessionId, unrelated);
  assert.deepEqual(await history.loadHistoryMatching(sessionId, { runIds: ['root'] }), []);
  await history.appendEvents(sessionId, [
    { type: 'message', role: 'user', runId: 'root', requestId: 'request', responseId: 'response', content: 'question',
      sourceContext: { queuedMessages: [{ requestId: 'alias', sourceContext: { messageId: 'nested-alias' } }] } },
    { type: 'message', role: 'assistant', runId: 'root', content: 'first answer' },
    { type: 'message', role: 'assistant', runId: 'continuation', responseId: 'response', content: 'continued answer' },
    { type: 'attachment_delivery', resultRunId: 'root', attachments: [{ name: 'result' }] },
  ]);
  const options = { runIds: ['root', 'continuation'], responseIds: ['response'] };
  const matches = await history.loadHistoryMatching(sessionId, options);
  assert.equal(matches.length, 4);
  assert.equal(matches[0].content, 'question');
  assert.equal(matches[2].content, 'continued answer');
  assert.deepEqual(matches.map(event => event.seq), [1201, 1202, 1203, 1204]);
  matches[3].attachments[0].name = 'mutated';
  assert.equal((await history.loadHistoryMatching(sessionId, options))[3].attachments[0].name, 'result');
  assert.equal((await history.loadHistoryMatching(sessionId, { sourceRequestIds: ['nested-alias'] })).length, 1);
  const start = performance.now();
  await Promise.all(Array.from({ length: 50 }, () => history.loadHistoryMatching(sessionId, options)));
  assert.ok(performance.now() - start < 3000, 'reply polling must not repeatedly copy unrelated large bodies');
  await history.appendEvent(sessionId, { type: 'message', role: 'assistant', runId: 'root', content: 'later answer' });
  assert.equal((await history.loadHistoryMatching(sessionId, options)).at(-1).content, 'later answer');

  const makeRun = (module, id, requestId, sessionId = 'lookup') => module.createRun({
    status: { id, sessionId, requestId, tool: 'codex', state: 'accepted' }, manifest: {},
  });
  await makeRun(runs, 'run_a', 'same');
  const recovered = await import('../chat/runs.mjs?restart=1');
  assert.equal((await recovered.findRunByRequest('lookup', 'same')).id, 'run_a');
  assert.equal(await recovered.findRunByRequest('other-session', 'same'), null);
  assert.equal(await recovered.findRunByRequest('lookup', 'missing'), null);
  await makeRun(runs, 'run_z', 'same');
  assert.equal((await recovered.findRunByRequest('lookup', 'same')).id, 'run_z', 'discover Runs created by another process');
  await runs.updateRun('run_z', { state: 'completed' });
  assert.equal((await recovered.findRunByRequest('lookup', 'same')).state, 'completed');
  await rm(runs.runDir('run_z'), { recursive: true });
  assert.equal((await recovered.findRunByRequest('lookup', 'same')).id, 'run_a');
  console.log('reply-history-lookup: ok');
} finally {
  await rm(home, { recursive: true, force: true });
}
