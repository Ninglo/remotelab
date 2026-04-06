#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const repoRoot = process.cwd();
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-session-connector-state-'));
process.env.HOME = tempHome;

const workspace = join(tempHome, 'workspace');
const mailboxRoot = join(tempHome, '.config', 'remotelab', 'agent-mailbox');
mkdirSync(workspace, { recursive: true });

const {
  buildEmailBindingId,
  ensureEmailConnectorBinding,
  resolveEmailConnectorBinding,
} = await import(pathToFileURL(join(repoRoot, 'lib', 'connector-bindings.mjs')).href);
const {
  initializeMailbox,
  saveOutboundConfig,
} = await import(pathToFileURL(join(repoRoot, 'lib', 'agent-mailbox.mjs')).href);
const {
  createSession,
  getRunState,
  getSession,
  killAll,
} = await import(pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href);
const {
  createRun,
  updateRun,
} = await import(pathToFileURL(join(repoRoot, 'chat', 'runs.mjs')).href);

try {
  const bindingId = buildEmailBindingId(mailboxRoot);
  const syntheticBinding = await resolveEmailConnectorBinding({ rootDir: mailboxRoot });
  assert.equal(syntheticBinding.id, bindingId, 'email bindings should be stable per mailbox root');
  assert.equal(syntheticBinding.capabilityState, 'binding_required');

  const persistedBinding = await ensureEmailConnectorBinding({ rootDir: mailboxRoot });
  assert.equal(persistedBinding.id, bindingId, 'registry should persist the same stable email binding id');
  assert.equal(persistedBinding.capabilityState, 'binding_required');

  const unboundSession = await createSession(workspace, 'codex', 'Unbound email reply', {
    completionTargets: [{
      id: 'email_target_unbound',
      type: 'email',
      bindingId,
      to: 'owner@example.com',
      subject: 'Re: unbound',
      mailboxRoot,
    }],
  });
  const unboundLoaded = await getSession(unboundSession.id);
  assert.equal(unboundLoaded?.connectors?.capabilityState, 'binding_required');
  assert.equal(unboundLoaded?.connectors?.deliveryState, 'drafted');
  assert.equal(unboundLoaded?.connectors?.actions?.[0]?.requiresUserAction?.kind, 'connect_binding');

  await initializeMailbox({
    rootDir: mailboxRoot,
    name: 'Rowan',
    localPart: 'rowan',
    domain: 'example.com',
    allowEmails: ['owner@example.com'],
  });

  const authorizationBinding = await resolveEmailConnectorBinding({ bindingId, rootDir: mailboxRoot });
  assert.equal(authorizationBinding.capabilityState, 'authorization_required');

  const authorizationSession = await createSession(workspace, 'codex', 'Authorized later', {
    completionTargets: [{
      id: 'email_target_auth',
      type: 'email',
      bindingId,
      to: 'owner@example.com',
      subject: 'Re: authorization',
      mailboxRoot,
    }],
  });
  const authorizationLoaded = await getSession(authorizationSession.id);
  assert.equal(authorizationLoaded?.connectors?.capabilityState, 'authorization_required');
  assert.equal(authorizationLoaded?.connectors?.actions?.[0]?.requiresUserAction?.kind, 'authorize_binding');

  await saveOutboundConfig(mailboxRoot, {
    provider: 'apple_mail',
    account: 'Primary',
    from: 'rowan@example.com',
  });

  const readyBinding = await resolveEmailConnectorBinding({ bindingId, rootDir: mailboxRoot });
  assert.equal(readyBinding.capabilityState, 'ready');

  const readySession = await createSession(workspace, 'codex', 'Ready email reply', {
    completionTargets: [{
      id: 'email_target_ready',
      type: 'email',
      bindingId,
      to: 'owner@example.com',
      subject: 'Re: ready',
      mailboxRoot,
    }],
  });
  const readyLoaded = await getSession(readySession.id);
  assert.equal(readyLoaded?.connectors?.capabilityState, 'ready');
  assert.equal(readyLoaded?.connectors?.deliveryState, 'drafted');
  assert.equal(readyLoaded?.connectors?.bindings?.[0]?.id, bindingId);
  assert.equal(readyLoaded?.connectors?.actions?.[0]?.bindingId, bindingId);

  const run = await createRun({
    status: {
      sessionId: readySession.id,
      requestId: 'req_ready',
      state: 'completed',
      tool: 'codex',
    },
    manifest: {
      sessionId: readySession.id,
      requestId: 'req_ready',
      folder: workspace,
      tool: 'codex',
      prompt: 'reply through the connector',
      options: {},
    },
  });
  await updateRun(run.id, (existing) => ({
    ...existing,
    completionTargets: {
      ...(existing.completionTargets || {}),
      email_target_ready: {
        ...(existing.completionTargets?.email_target_ready || {}),
        state: 'failed',
        lastError: 'SMTP rejected the message',
      },
    },
  }));

  const runState = await getRunState(run.id);
  assert.equal(runState?.connectors?.capabilityState, 'ready');
  assert.equal(runState?.connectors?.deliveryState, 'delivery_failed');
  assert.equal(runState?.connectors?.actions?.[0]?.deliveryState, 'delivery_failed');
  assert.equal(runState?.connectors?.actions?.[0]?.message, 'SMTP rejected the message');
  assert.equal(runState?.connectors?.actions?.[0]?.retryable, true);
} finally {
  killAll();
  rmSync(tempHome, { recursive: true, force: true });
}

console.log('test-session-connector-state-surface: ok');
