#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createSessionListItem, createSessionDetail } from '../chat/session-api-shapes.mjs';

const unused = { toJSON() { throw new Error('an unused private payload was serialized'); } };
const session = { id: 'projection', task: unused, sourceContext: unused,
  feishuProgressChanges: unused, activity: { status: 'running' },
  queuedMessages: [{ text: 'pending input' }], deliveryIssues: [{ state: 'unknown' }],
  workAwareness: { revision: 4, works: [{ status: 'active', result: unused }, { status: 'completed', result: unused }] } };
const item = createSessionListItem(session);
assert.deepEqual(item.workAwareness, { revision: 4, activeCount: 1 });
assert.equal(item.task, undefined);
assert.equal(item.sourceContext, undefined);
assert.equal(item.queuedMessages, undefined);
item.activity.status = 'caller change';
assert.equal(session.activity.status, 'running', 'projected metadata stays independent of canonical state');
assert.equal(session.queuedMessages.length, 1);
assert.equal(session.workAwareness.works.length, 2);

const detail = createSessionDetail({ ...session, workAwareness: { revision: 4, works: [{ status: 'active' }] } });
assert.equal(detail.queuedMessages[0].text, 'pending input');
assert.equal(detail.deliveryIssues[0].state, 'unknown');
assert.equal(detail.workAwareness.works.length, 1);
detail.queuedMessages[0].text = 'caller change';
assert.equal(session.queuedMessages[0].text, 'pending input');
console.log('Session API projections: unused payloads skipped, list/detail fields preserved and mutation isolation passed.');
