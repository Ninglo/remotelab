#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-session-app-scope-'));
process.env.HOME = tempHome;

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
  assert.equal(ownerChat.appId, 'chat', 'owner sessions should default to the built-in chat app');

  const githubSession = await createSession(workspace, 'codex', 'GitHub issue triage', {
    appId: 'github',
    group: 'GitHub',
  });
  assert.equal(githubSession.appId, 'github');

  const storedAfterCreate = readSessionsFile();
  assert.equal(
    storedAfterCreate.find((entry) => entry.id === ownerChat.id)?.appId,
    'chat',
    'newly created owner sessions should persist the default app id',
  );
  assert.equal(
    storedAfterCreate.find((entry) => entry.id === githubSession.id)?.appId,
    'github',
    'explicit app ids should persist as canonical session metadata',
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
    loadedLegacy?.appId,
    'chat',
    'legacy owner sessions should read back through the default chat app',
  );

  const emailReuse = await createSession(workspace, 'codex', 'Reply via email', {
    appId: 'email',
    externalTriggerId: 'email-thread:legacy-root',
    group: 'Mail',
  });
  assert.equal(emailReuse.id, legacyExternalId, 'external trigger reuse should keep the same session id');
  assert.equal(emailReuse.appId, 'email', 'external trigger refresh should upgrade legacy sessions to the connector app scope');

  const chatSessions = await listSessions({ appId: 'chat' });
  assert.equal(chatSessions.some((session) => session.id === ownerChat.id), true);
  assert.equal(chatSessions.some((session) => session.id === legacySessionId), true);
  assert.equal(chatSessions.some((session) => session.id === githubSession.id), false);

  const githubSessions = await listSessions({ appId: 'github' });
  assert.deepEqual(
    githubSessions.map((session) => session.id),
    [githubSession.id],
    'app-scoped listing should isolate GitHub sessions',
  );

  const emailSessions = await listSessions({ appId: 'email' });
  assert.deepEqual(
    emailSessions.map((session) => session.id),
    [legacyExternalId],
    'app-scoped listing should isolate email sessions',
  );
} finally {
  killAll();
  rmSync(tempHome, { recursive: true, force: true });
}

console.log('test-session-app-scope: ok');
