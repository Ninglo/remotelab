#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const bootstrapSource = readFileSync(join(repoRoot, 'static', 'chat', 'bootstrap.js'), 'utf8') + '\n' + readFileSync(join(repoRoot, 'static', 'chat', 'bootstrap-session-catalog.js'), 'utf8');

function extractFunctionSource(source, functionName) {
  const marker = `function ${functionName}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${functionName} should exist`);
  const paramsStart = source.indexOf('(', start);
  assert.notEqual(paramsStart, -1, `${functionName} should have parameters`);
  let paramsDepth = 0;
  let braceStart = -1;
  for (let index = paramsStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') paramsDepth += 1;
    if (char === ')') {
      paramsDepth -= 1;
      if (paramsDepth === 0) {
        braceStart = source.indexOf('{', index);
        break;
      }
    }
  }
  assert.notEqual(braceStart, -1, `${functionName} should have a body`);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  throw new Error(`Unable to extract ${functionName}`);
}

const getSessionSortTimeSource = extractFunctionSource(bootstrapSource, 'getSessionSortTime');
const getSessionPinSortRankSource = extractFunctionSource(bootstrapSource, 'getSessionPinSortRank');
const compareSessionListSessionsSource = extractFunctionSource(bootstrapSource, 'compareSessionListSessions');
const sortSessionsInPlaceSource = extractFunctionSource(bootstrapSource, 'sortSessionsInPlace');

const context = {
  console,
  Date,
  sessionStateModel: {
    getSessionSortTime(session) {
      return Date.parse(session.lastEventAt || session.updatedAt || session.created || '') || 0;
    },
    compareSessionListSessions(a, b) {
      return (b.rank || 0) - (a.rank || 0)
        || (Date.parse(b.lastEventAt || b.updatedAt || b.created || '') || 0)
          - (Date.parse(a.lastEventAt || a.updatedAt || a.created || '') || 0);
    },
  },
  sessions: [
    {
      id: 'metadata-only-newer',
      rank: 1,
      updatedAt: '2026-03-12T12:00:00.000Z',
      lastEventAt: '2026-03-12T08:00:00.000Z',
    },
    {
      id: 'actual-activity-newer',
      rank: 5,
      updatedAt: '2026-03-12T09:00:00.000Z',
      lastEventAt: '2026-03-12T11:00:00.000Z',
    },
    {
      id: 'pinned-session',
      pinned: true,
      updatedAt: '2026-03-12T07:00:00.000Z',
      lastEventAt: '2026-03-12T07:00:00.000Z',
    },
  ],
};
context.globalThis = context;

vm.runInNewContext(
  `${getSessionSortTimeSource}\n${getSessionPinSortRankSource}\n${compareSessionListSessionsSource}\n${sortSessionsInPlaceSource}`,
  context,
  { filename: 'static/chat/bootstrap-session-catalog.js' },
);

context.sortSessionsInPlace();

assert.deepEqual(
  context.sessions.map((session) => session.id),
  ['pinned-session', 'actual-activity-newer', 'metadata-only-newer'],
  'sidebar sorting should follow pinning first and then the delegated attention comparator',
);

console.log('test-chat-sidebar-session-sorting: ok');
