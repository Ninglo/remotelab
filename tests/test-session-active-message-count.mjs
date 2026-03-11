#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const home = mkdtempSync(join(tmpdir(), 'remotelab-active-message-count-'));

process.env.HOME = home;

const sessionManager = await import(
  pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href
);
const history = await import(
  pathToFileURL(join(repoRoot, 'chat', 'history.mjs')).href
);

const {
  createSession,
  getSession,
  killAll,
  listSessions,
} = sessionManager;
const {
  appendEvents,
  setContextHead,
} = history;

try {
  const session = await createSession(home, 'codex', 'Count test');

  await appendEvents(session.id, [
    { type: 'message', role: 'user', content: 'First user message', timestamp: 1 },
    { type: 'message', role: 'assistant', content: 'First assistant reply', timestamp: 2 },
    { type: 'status', content: 'status events should not count', timestamp: 3 },
    { type: 'message', role: 'user', content: 'Second user message', timestamp: 4 },
    { type: 'tool_result', output: 'tool output should not count', timestamp: 5 },
    { type: 'message', role: 'assistant', content: 'Second assistant reply', timestamp: 6 },
  ]);

  const fullHistorySession = await getSession(session.id);
  assert.equal(fullHistorySession?.messageCount, 4, 'session should expose total text message count');
  assert.equal(fullHistorySession?.activeMessageCount, 4, 'session should count all text messages before compaction');

  await setContextHead(session.id, {
    mode: 'summary',
    summary: 'Archive the first exchange.',
    activeFromSeq: 2,
    compactedThroughSeq: 2,
    updatedAt: '2026-03-11T00:00:00.000Z',
    source: 'manual',
  });

  const compactedSession = await getSession(session.id);
  assert.equal(compactedSession?.messageCount, 4, 'compaction should not change total history message count');
  assert.equal(compactedSession?.activeMessageCount, 2, 'active count should exclude archived messages and non-message events');

  const listedSession = (await listSessions()).find((entry) => entry.id === session.id);
  assert.equal(listedSession?.messageCount, 4, 'session list should expose the total history message count');
  assert.equal(listedSession?.activeMessageCount, 2, 'session list should expose only active messages after the archive boundary');

  await setContextHead(session.id, {
    mode: 'summary',
    summary: 'Archive the whole visible transcript.',
    activeFromSeq: 6,
    compactedThroughSeq: 6,
    updatedAt: '2026-03-11T00:01:00.000Z',
    source: 'manual',
  });

  const fullyArchivedSession = await getSession(session.id);
  assert.equal(fullyArchivedSession?.messageCount, 4, 'full archival should still preserve total history count');
  assert.equal(fullyArchivedSession?.activeMessageCount, 0, 'full archival should let the active message count fall to zero');

  console.log('test-session-active-message-count: ok');
} finally {
  killAll();
  rmSync(home, { recursive: true, force: true });
}
