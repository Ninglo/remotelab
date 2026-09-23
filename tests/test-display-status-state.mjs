#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  emptySignalStore, makeStatusSnapshot, replaceSource, selectOfficialScene, validateSourcePacket,
} from '../display/status-state.mjs';
import { remotelabStatusSource } from '../display/remotelab-status-source.mjs';
import { renderTheme } from '../display/themes/official.mjs';

const now = Date.now();
const at = (delta) => new Date(now + delta).toISOString();
const packet = (sequence, phase = 'progress') => ({
  schemaVersion: 1, sequence, label: 'Evaluation', observedAt: at(0), validUntil: at(60_000),
  signals: [{
    id: 'run-42', phase, title: '评测状态', summary: '当前进度已经更新。', subject: 'RoboDojo',
    destination: '去评测页面', occurredAt: at(0), expiresAt: at(60_000),
    evidence: 'confirmed', urgency: 'normal',
  }],
});

let store = emptySignalStore();
const first = replaceSource(store, 'person-a', 'evaluation', packet(1), now);
assert.equal(first.changed, true);
store = first.store;
assert.equal(replaceSource(store, 'person-a', 'evaluation', packet(1), now).reason, 'duplicate');
assert.equal(replaceSource(store, 'person-a', 'evaluation', packet(0), now).reason, 'older_sequence');
assert.throws(() => replaceSource(store, 'person-a', 'evaluation', packet(1, 'attention'), now), { status: 409 });
assert.equal(store.people['person-b'], undefined, 'source state must be scoped to one Person');
assert.throws(() => validateSourcePacket({ ...packet(2), label: '<script>\n' }, now), { status: 400 });
assert.throws(() => validateSourcePacket({ ...packet(2), signals: [{ ...packet(2).signals[0], phase: 'upcoming' }] }, now), { status: 400 });

let snapshot = makeStatusSnapshot(store.people['person-a'], now);
assert.equal(selectOfficialScene(snapshot, now).kind, 'progress');
assert.equal(makeStatusSnapshot(store.people['person-a'], now + 61_000).signals[0].active, false);
assert.equal(selectOfficialScene(makeStatusSnapshot(store.people['person-a'], now + 61_000), now + 61_000).kind, 'stale');

store = replaceSource(store, 'person-a', 'evaluation', packet(2, 'attention'), now).store;
const remote = validateSourcePacket(remotelabStatusSource({ running: 2, queued: 0, pendingReview: 9, deliveryIssues: 0 }, now), now);
snapshot = makeStatusSnapshot({ ...store.people['person-a'], remotelab: remote }, now);
assert.equal(selectOfficialScene(snapshot, now).signal.sourceId, 'evaluation');
assert.equal(remote.signals.find((signal) => signal.id === 'pending-review').phase, 'note');
assert.equal(remote.signals.some((signal) => signal.phase === 'attention'), false, 'review heuristic must not become an action request');
const svg = renderTheme(snapshot, { metrics: { running: 2, pendingReview: 9 }, nowMs: now });
assert.match(svg, /width="1920" height="480"/);
assert.match(svg, /需要你处理/);
assert.doesNotMatch(renderTheme(makeStatusSnapshot({ evaluation: validateSourcePacket({ ...packet(3), signals: [{ ...packet(3).signals[0], title: '<unsafe>' }] }, now) }, now), { nowMs: now }), /<unsafe>/);
console.log('ok - display source replacement, freshness, Person scope, selection, and theme escaping');
