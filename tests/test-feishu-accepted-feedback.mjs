import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'feishu-accepted-feedback-'));
setIsolatedTestHome(home);
try {
  const { requests } = await import('../chat/requests.mjs');
  const { appendEvent, readEventsAfter } = await import('../chat/history.mjs');
  const { observeAcceptedSessionMessage, observeSessionMessage, recordSessionObservationDecision } =
    await import('../chat/session-observations.mjs');
  const sourceContext = { connector: 'feishu', sourceRouteId: 'bot', chatId: 'group',
    chatType: 'group', messageId: 'input', sender: { name: 'Human' } };
  await appendEvent('s', { type: 'message', role: 'user', content: 'Earlier context', timestamp: Date.now() });
  const packet = { sessionId: 's', requestId: 'input', text: 'Thanks for the result',
    options: { feishuConnectorAuthenticated: true, sourceContext } };
  const accepted = (await requests.accept(packet)).record;
  await appendEvent('s', { type: 'message', role: 'assistant', content: 'Later answer',
    timestamp: Date.parse(accepted.acceptedAt) + 1000 });
  // Queued admission is enough: no Run or second human event is needed.
  const feedback = await observeAcceptedSessionMessage('s', 'input');
  assert.equal(feedback.accepted, true);
  assert.deepEqual(feedback.recent.map(x => x.text), ['Earlier context', packet.text]);
  assert.equal((await readEventsAfter('s', 0)).length, 2, 'feedback adds no input and excludes later output');
  await appendEvent('s', { type: 'message', role: 'user', content: packet.text,
    requestId: 'input', sourceContext, timestamp: Date.now() });
  await recordSessionObservationDecision('s', 'input', { purpose: 'reaction', emojiType: 'THANKS' });
  await requests.settle((await requests.byRequest('s', 'input')).key, { state: 'completed' });
  await requests.mutate((await requests.byRequest('s', 'input')).key,
    r => ({ ...r, releasedAt: new Date().toISOString(), postCompletionPending: false }));
  await requests.archiveFinished((await requests.byRequest('s', 'input')).key);
  const recovered = await observeAcceptedSessionMessage('s', 'input');
  assert.equal(recovered.decision.emojiType, 'THANKS');
  assert.equal(recovered.recent.filter(x => x.text === packet.text).length, 1);
  await recordSessionObservationDecision('s', 'input', { purpose: 'reaction', emojiType: 'WOW' });
  const history = await readEventsAfter('s', 0);
  assert.equal(history.filter(e => e.type === 'reaction_decision').length, 1);
  assert.equal(history.filter(e => e.role === 'user' && e.requestId === 'input').length, 1);
  const legacySource = { ...sourceContext, messageId: 'legacy-source' };
  await appendEvent('legacy', { type: 'message', role: 'user', content: 'Earlier legacy context', timestamp: Date.now() });
  await observeSessionMessage('legacy', { sourceMessageId: legacySource.messageId,
    requestId: 'legacy-input', text: packet.text, sourceContext: legacySource });
  await requests.accept({ ...packet, sessionId: 'legacy', requestId: 'legacy-input',
    options: { ...packet.options, sourceContext: legacySource } });
  const legacyFeedback = await observeAcceptedSessionMessage('legacy', 'legacy-input');
  assert.deepEqual(legacyFeedback.recent.map(x => x.text), ['Earlier legacy context', packet.text]);
  assert.equal((await readEventsAfter('legacy', 0)).filter(e => e.role === 'user').length, 2);
  await assert.rejects(observeAcceptedSessionMessage('other-session', 'input'), /accepted Feishu/);
  await assert.rejects(observeAcceptedSessionMessage('s', 'missing'), /accepted Feishu/);
  for (const [id, options] of [
    ['browser', { sourceContext }],
    ['private', { feishuConnectorAuthenticated: true, sourceContext: { ...sourceContext, chatType: 'p2p' } }],
  ]) {
    await requests.accept({ ...packet, requestId: id, options });
    await assert.rejects(observeAcceptedSessionMessage('s', id), /accepted Feishu/);
  }
  console.log('Accepted feedback: queued and archived Requests, no duplicate input, durable decision and source isolation passed');
} finally { await rm(home, { recursive: true, force: true }); }
