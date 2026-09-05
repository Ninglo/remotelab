#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-session-app-scope-'));
setIsolatedTestHome(tempHome);

const workspace = join(tempHome, 'workspace');
mkdirSync(workspace, { recursive: true });

const sessionManager = await import(
  pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href
);

const {
  createSession,
  getSession,
  killAll,
  listSessions,
} = sessionManager;

const sessionsPath = join(tempHome, '.config', 'remotelab', 'chat-sessions.json');

function readSessionsFile() {
  return JSON.parse(readFileSync(sessionsPath, 'utf8'));
}

try {
  const ownerChat = await createSession(workspace, 'codex', 'Owner chat');
  assert.equal(ownerChat.sourceId, 'chat', 'owner sessions should persist chat as the canonical source id');

  const githubSession = await createSession(workspace, 'codex', 'GitHub issue triage', {
    sourceId: 'github',
    sourceName: 'GitHub',
    group: 'GitHub',
  });
  assert.equal(githubSession.sourceId, 'github', 'connector-style sessions should persist a source id');
  assert.equal(githubSession.sourceName, 'GitHub', 'connector-style sessions should persist a source name');

  const storedAfterCreate = readSessionsFile();
  assert.equal(
    storedAfterCreate.find((entry) => entry.id === ownerChat.id)?.sourceId,
    'chat',
    'newly created owner sessions should also persist the default source id',
  );
  assert.equal(
    storedAfterCreate.find((entry) => entry.id === githubSession.id)?.sourceId,
    'github',
    'explicit connector source ids should persist as canonical session metadata',
  );
  assert.equal(
    storedAfterCreate.find((entry) => entry.id === githubSession.id)?.sourceName,
    'GitHub',
    'session-scoped source names should persist for owner UI rendering',
  );

  const legacySessionId = 'legacy_session_no_app';
  const legacyExternalId = 'legacy_email_thread';
  storedAfterCreate.push({
    id: legacySessionId,
    folder: workspace,
    tool: 'codex',
    name: 'Legacy owner session',
    created: '2026-03-10T00:00:00.000Z',
    updatedAt: '2026-03-10T00:00:00.000Z',
  });
  storedAfterCreate.push({
    id: legacyExternalId,
    folder: workspace,
    tool: 'codex',
    name: 'Legacy email thread',
    externalTriggerId: 'email-thread:legacy-root',
    created: '2026-03-10T00:01:00.000Z',
    updatedAt: '2026-03-10T00:01:00.000Z',
  });
  writeFileSync(sessionsPath, `${JSON.stringify(storedAfterCreate, null, 2)}\n`, 'utf8');

  const loadedLegacy = await getSession(legacySessionId);
  assert.equal(
    loadedLegacy?.sourceId,
    'chat',
    'legacy owner sessions should be normalized onto the canonical chat source id',
  );

  const emailReuse = await createSession(workspace, 'codex', 'Reply via email', {
    sourceId: 'email',
    sourceName: 'Email',
    externalTriggerId: 'email-thread:legacy-root',
    group: 'Mail',
  });
  assert.equal(emailReuse.id, legacyExternalId, 'external trigger reuse should keep the same session id');
  assert.equal(emailReuse.sourceId, 'email', 'external trigger refresh should also upgrade legacy sessions to the canonical source id');
  assert.equal(emailReuse.sourceName, 'Email', 'external trigger refresh should also preserve the canonical source label');

  const storedAfterReuse = readSessionsFile();
  assert.equal(
    storedAfterReuse.find((entry) => entry.id === legacyExternalId)?.sourceId,
    'email',
    'session reuse should persist canonical source ids for legacy sessions',
  );
  assert.equal(
    storedAfterReuse.find((entry) => entry.id === legacyExternalId)?.sourceName,
    'Email',
    'session reuse should persist canonical source labels for legacy sessions',
  );

  const chatSessions = await listSessions({ sourceId: 'chat' });
  assert.equal(chatSessions.some((session) => session.id === ownerChat.id), true);
  assert.equal(chatSessions.some((session) => session.id === legacySessionId), true);
  assert.equal(chatSessions.some((session) => session.id === githubSession.id), false);

  const githubSessions = await listSessions({ sourceId: 'github' });
  assert.deepEqual(
    githubSessions.map((session) => session.id),
    [githubSession.id],
    'source-scoped listing should isolate GitHub sessions',
  );

  const emailSessions = await listSessions({ sourceId: 'email' });
  assert.deepEqual(
    emailSessions.map((session) => session.id),
    [legacyExternalId],
    'source-scoped listing should isolate email sessions',
  );
} finally {
  killAll();
  rmSync(tempHome, { recursive: true, force: true });
}

console.log('test-session-app-scope: ok');
