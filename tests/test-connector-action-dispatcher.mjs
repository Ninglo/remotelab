#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const repoRoot = process.cwd();
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-connector-dispatcher-'));
process.env.HOME = tempHome;
delete process.env.REMOTELAB_INSTANCE_ROOT;
delete process.env.REMOTELAB_CONFIG_DIR;
delete process.env.REMOTELAB_PUBLIC_BASE_URL;

const workspace = join(tempHome, 'workspace');
const mailboxRoot = join(tempHome, '.config', 'remotelab', 'agent-mailbox');
const fakeCalendarTokenPath = join(tempHome, 'google-calendar-token.json');
mkdirSync(workspace, { recursive: true });
writeFileSync(fakeCalendarTokenPath, JSON.stringify({ access_token: 'test-token' }), 'utf8');

const {
  sanitizeAllCompletionTargets,
  sanitizeCompletionTargets,
  dispatchSessionConnectorActions,
} = await import(pathToFileURL(join(repoRoot, 'lib', 'connector-action-dispatcher.mjs')).href);

const {
  ensureCalendarConnectorBinding,
  resolveCalendarConnectorBinding,
  ensureEmailConnectorBinding,
  listConnectorBindings,
} = await import(pathToFileURL(join(repoRoot, 'lib', 'connector-bindings.mjs')).href);

const {
  initializeMailbox,
  saveOutboundConfig,
} = await import(pathToFileURL(join(repoRoot, 'lib', 'agent-mailbox.mjs')).href);

const {
  createSession,
  getSession,
  killAll,
} = await import(pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href);

try {
  // --- sanitizeAllCompletionTargets handles both email and calendar ---
  const mixed = sanitizeAllCompletionTargets([
    { id: 'e1', type: 'email', to: 'a@example.com', subject: 'Hi' },
    { id: 'c1', type: 'calendar', title: 'Standup', startTime: '2026-04-07T10:00:00Z' },
    { id: 'unknown', type: 'sms', to: '+1555' },
  ]);
  assert.equal(mixed.length, 2, 'should keep email and calendar, drop unknown');
  assert.equal(mixed[0].type, 'email');
  assert.equal(mixed[1].type, 'calendar');
  assert.equal(mixed[1].title, 'Standup');

  // --- sanitizeCompletionTargets filters only non-email types ---
  const calOnly = sanitizeCompletionTargets([
    { id: 'e1', type: 'email', to: 'a@example.com' },
    { id: 'c1', type: 'calendar', title: 'Meeting' },
  ]);
  assert.equal(calOnly.length, 1, 'should keep only calendar');
  assert.equal(calOnly[0].type, 'calendar');

  // --- Calendar binding lifecycle ---
  const calBinding = await ensureCalendarConnectorBinding({
    provider: 'google',
    accountHint: 'user@gmail.com',
    title: 'Personal Calendar',
  });
  assert.equal(calBinding.connectorId, 'calendar');
  assert.equal(calBinding.provider, 'google');
  assert.equal(calBinding.accountHint, 'user@gmail.com');
  assert.equal(calBinding.capabilityState, 'authorization_required',
    'calendar without tokenPath should be authorization_required');

  const calBindingWithToken = await ensureCalendarConnectorBinding({
    provider: 'google',
    accountHint: 'user@gmail.com',
    tokenPath: fakeCalendarTokenPath,
    title: 'Personal Calendar',
  });
  assert.equal(calBindingWithToken.capabilityState, 'ready',
    'calendar with provider + accountHint + tokenPath should be ready');
  assert.equal(calBindingWithToken.id, calBinding.id,
    'same provider+accountHint should get same binding id');

  const resolved = await resolveCalendarConnectorBinding({ bindingId: calBinding.id });
  assert.equal(resolved?.connectorId, 'calendar');
  assert.equal(resolved?.capabilityState, 'ready');

  const resolvedEmpty = await resolveCalendarConnectorBinding({ bindingId: 'nonexistent' });
  assert.equal(resolvedEmpty, null, 'unknown binding should return null');

  // --- listConnectorBindings returns both email and calendar ---
  const allBindings = await listConnectorBindings();
  const emailBindings = allBindings.filter((b) => b.connectorId === 'email');
  const calBindings = allBindings.filter((b) => b.connectorId === 'calendar');
  assert.ok(emailBindings.length >= 1, 'should have at least the compatibility email binding');
  assert.equal(calBindings.length, 1, 'should have exactly one calendar binding');

  // --- Session with mixed completion targets projects connector surface ---
  await initializeMailbox({
    rootDir: mailboxRoot,
    name: 'TestBot',
    localPart: 'testbot',
    domain: 'example.com',
    allowEmails: ['owner@example.com'],
  });
  await saveOutboundConfig(mailboxRoot, {
    provider: 'apple_mail',
    account: 'Primary',
    from: 'testbot@example.com',
  });
  const emailBinding = await ensureEmailConnectorBinding({ rootDir: mailboxRoot });

  const session = await createSession(workspace, 'codex', 'Mixed connector session', {
    completionTargets: [
      {
        id: 'email_1',
        type: 'email',
        bindingId: emailBinding.id,
        to: 'owner@example.com',
        subject: 'Re: test',
        mailboxRoot,
      },
      {
        id: 'cal_1',
        type: 'calendar',
        bindingId: calBinding.id,
        title: 'Team Standup',
        startTime: '2026-04-07T10:00:00Z',
        endTime: '2026-04-07T10:30:00Z',
      },
    ],
  });

  const loaded = await getSession(session.id);
  assert.ok(loaded?.completionTargets, 'session should store completion targets');
  assert.equal(loaded.completionTargets.length, 2, 'should have 2 targets');
  assert.ok(loaded?.connectors, 'session should have connectors surface');
  assert.ok(loaded.connectors.actions.length >= 2, 'should have actions for both connectors');

  const emailAction = loaded.connectors.actions.find((a) => a.connectorId === 'email');
  const calAction = loaded.connectors.actions.find((a) => a.connectorId === 'calendar');
  assert.ok(emailAction, 'should have email action');
  assert.ok(calAction, 'should have calendar action');
  assert.equal(emailAction.capabilityState, 'ready');
  assert.equal(calAction.capabilityState, 'ready');

  // --- dispatchSessionConnectorActions with no session/run returns empty ---
  const emptyResult = await dispatchSessionConnectorActions(null, null);
  assert.deepEqual(emptyResult, []);

  // --- dispatchSessionConnectorActions with calendar targets returns stub results ---
  const calOnlySession = {
    id: 'test-cal-only',
    completionTargets: [
      { id: 'cal_stub', type: 'calendar', title: 'Standup' },
    ],
  };
  const calResults = await dispatchSessionConnectorActions(calOnlySession, { id: 'run1' });
  assert.equal(calResults.length, 1);
  assert.equal(calResults[0].connectorId, 'calendar');
  assert.equal(calResults[0].state, 'sent');
  assert.equal(calResults[0].result.capabilityState, 'ready');

  // --- bound calendar targets should attempt direct connector delivery ---
  const directCalendarSession = {
    id: 'test-cal-direct',
    completionTargets: [
      {
        id: 'cal_direct',
        type: 'calendar',
        bindingId: calBinding.id,
        credentialsPath: '/tmp/does-not-exist-google-creds.json',
        title: 'Direct delivery',
        startTime: '2026-04-07T11:00:00Z',
        endTime: '2026-04-07T11:30:00Z',
        reminderMinutesBefore: 3,
      },
    ],
  };
  const directResults = await dispatchSessionConnectorActions(directCalendarSession, { id: 'run2' });
  assert.equal(directResults.length, 1);
  assert.equal(directResults[0].connectorId, 'calendar');
  assert.equal(directResults[0].state, 'failed');
  assert.equal(directResults[0].result.deliveryState, 'delivery_failed');
  assert.match(directResults[0].result.message, /Bound calendar delivery failed/);

  console.log('test-connector-action-dispatcher: ok');
} finally {
  killAll();
  rmSync(tempHome, { recursive: true, force: true });
}
