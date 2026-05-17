#!/usr/bin/env node
import assert from 'assert/strict';
import { parseSessionGetRoute } from './chat/session-route-utils.mjs';

assert.deepEqual(
  parseSessionGetRoute('/api/sessions'),
  { kind: 'list' },
  'session collection route should stay distinct',
);

assert.deepEqual(
  parseSessionGetRoute('/api/sessions/archived'),
  { kind: 'archived-list' },
  'archive should stay a dedicated collection route',
);

assert.deepEqual(
  parseSessionGetRoute('/api/sessions/session-123'),
  { kind: 'detail', sessionId: 'session-123' },
  'session detail routes should still parse normally',
);

assert.deepEqual(
  parseSessionGetRoute('/api/sessions/session-123/events'),
  { kind: 'events', sessionId: 'session-123' },
  'session event routes should still parse normally',
);

assert.deepEqual(
  parseSessionGetRoute('/api/sessions/session-123/events/delta'),
  { kind: 'event-delta', sessionId: 'session-123' },
  'session event delta routes should parse normally',
);

assert.deepEqual(
  parseSessionGetRoute('/api/sessions/session-123/events/blocks/10-20'),
  { kind: 'event-block', sessionId: 'session-123', startSeq: 10, endSeq: 20 },
  'collapsed event-block routes should parse normally',
);

assert.equal(
  parseSessionGetRoute('/api/sessions/session-123/unarchive'),
  null,
  'non-GET action routes should not be parsed as GET session routes',
);

console.log('test-session-route-utils: ok');
