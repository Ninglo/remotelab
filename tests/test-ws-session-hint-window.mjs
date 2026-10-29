import assert from 'node:assert/strict';
process.env.REMOTELAB_SESSION_HINT_WINDOW_MS = '40';
const { broadcastAll, setWss, onSessionInvalidation } = await import('../chat/ws-clients.mjs');

const sent = [];
setWss({ clients: [{ readyState: 1, send: data => sent.push(JSON.parse(data)) }] });
const local = [];
onSessionInvalidation(msg => local.push(msg));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

for (let n = 0; n < 10; n++) broadcastAll({ type: 'session_invalidated', sessionId: 'a' });
broadcastAll({ type: 'session_invalidated', sessionId: 'b' });
assert.deepEqual(sent.map(m => m.sessionId), ['a', 'b'], 'the first hint per Session is sent immediately');
assert.equal(local.length, 11, 'local projections still receive every hint');
broadcastAll({ type: 'session_invalidated', sessionId: 'a', progressCard: { anchorSeq: 7 } });
assert.equal(sent.at(-1).progressCard.anchorSeq, 7, 'hints with payload are never merged');
broadcastAll({ type: 'sessions_invalidated' });
assert.equal(sent.at(-1).type, 'sessions_invalidated');
await wait(60);
assert.equal(sent.filter(m => m.sessionId === 'a' && !m.progressCard).length, 2, 'a burst collapses into one trailing hint');
assert.equal(sent.filter(m => m.sessionId === 'b').length, 1, 'a single hint has no trailing duplicate');
await wait(60);
broadcastAll({ type: 'session_invalidated', sessionId: 'a' });
assert.equal(sent.filter(m => m.sessionId === 'a' && !m.progressCard).length, 3, 'after a quiet window the next hint is immediate again');
console.log('test-ws-session-hint-window: ok (leading send, trailing collapse, payload passthrough, local listeners)');
