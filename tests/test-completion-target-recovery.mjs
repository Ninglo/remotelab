import assert from 'node:assert/strict';
import { createSessionTurnCompletionHelpers } from '../chat/session-turn-completion.mjs';

const noTargets = createSessionTurnCompletionHelpers({
  loadSessionsMeta: async () => [{ id: 'plain-session' }],
  listRunIds: async () => { throw new Error('must not scan Runs without completion subscriptions'); },
});
await noTargets.resumePendingCompletionTargets();

const reads = [];
const withTargets = createSessionTurnCompletionHelpers({
  loadSessionsMeta: async () => [{ id: 'subscribed', completionTargets: ['target'] }, { id: 'plain-session' }],
  listRunIds: async () => ['irrelevant', 'relevant'],
  getRun: async id => ({ id, sessionId: id === 'relevant' ? 'subscribed' : 'plain-session', state: 'completed' }),
  isTerminalRunState: state => state === 'completed',
  getSession: async id => { reads.push(id); return { id, completionTargets: [] }; },
});
await withTargets.resumePendingCompletionTargets();
assert.deepEqual(reads, ['subscribed'], 'only Sessions with completion subscriptions need history enrichment');
console.log('completion-target-recovery: ok');
