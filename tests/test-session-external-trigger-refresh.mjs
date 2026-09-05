#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-external-trigger-refresh-'));
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
} = sessionManager;

try {
  const first = await createSession(workspace, 'codex', 'Mail: hello', {
    group: 'Mail',
    description: 'Inbound email from owner@example.com about hello',
    systemPrompt: 'Reply with plain text only.',
    activeAgreements: ['Keep replies as plain text email bodies.'],
    externalTriggerId: 'email-thread:%3Croot-thread%40example.com%3E',
    completionTargets: [{
      id: 'email_target_1',
      type: 'email',
      requestId: 'req_1',
      to: 'owner@example.com',
      subject: 'Re: hello',
      inReplyTo: '<root-thread@example.com>',
      references: '<root-thread@example.com>',
    }],
  });

  const second = await createSession(workspace, 'codex', 'Mail: should not rename', {
    group: 'Mail',
    description: 'Inbound email from owner@example.com about Re: hello',
    systemPrompt: 'Reply with plain text only and keep thread continuity.',
    externalTriggerId: 'email-thread:%3Croot-thread%40example.com%3E',
    completionTargets: [{
      id: 'email_target_2',
      type: 'email',
      requestId: 'req_2',
      to: 'owner@example.com',
      subject: 'Re: hello',
      inReplyTo: '<follow-up@example.com>',
      references: '<root-thread@example.com> <follow-up@example.com>',
    }],
  });

  assert.equal(second.id, first.id, 'same external trigger should reuse the existing session');
  assert.equal(second.name, 'hello', 'reused connector sessions should preserve the original normalized title');
  assert.equal(second.description, 'Inbound email from owner@example.com about Re: hello');
  assert.equal(second.systemPrompt, 'Reply with plain text only and keep thread continuity.');
  assert.deepEqual(second.activeAgreements, ['Keep replies as plain text email bodies.']);
  assert.equal(second.completionTargets?.length, 1);
  assert.equal(second.completionTargets?.[0]?.id, 'email_target_2');
  assert.equal(second.completionTargets?.[0]?.inReplyTo, '<follow-up@example.com>');
  assert.equal(second.completionTargets?.[0]?.references, '<root-thread@example.com> <follow-up@example.com>');

  const loaded = await getSession(first.id);
  assert.equal(loaded?.id, first.id);
  assert.equal(loaded?.description, 'Inbound email from owner@example.com about Re: hello');
  assert.deepEqual(loaded?.activeAgreements, ['Keep replies as plain text email bodies.']);
  assert.equal(loaded?.completionTargets?.[0]?.id, 'email_target_2');
  assert.equal(loaded?.completionTargets?.[0]?.inReplyTo, '<follow-up@example.com>');

  const third = await createSession(workspace, 'codex', 'Mail: clear prompt', {
    group: 'Mail',
    description: 'Inbound email from owner@example.com about Re: hello again',
    systemPrompt: '',
    externalTriggerId: 'email-thread:%3Croot-thread%40example.com%3E',
  });

  assert.equal(third.id, first.id, 'same external trigger should keep reusing the existing session');
  assert.equal(third.systemPrompt || '', '', 'explicit empty systemPrompt should clear the previous connector override');
} finally {
  killAll();
  rmSync(tempHome, { recursive: true, force: true });
}

console.log('test-session-external-trigger-refresh: ok');
