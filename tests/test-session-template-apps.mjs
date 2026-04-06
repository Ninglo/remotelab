#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const home = mkdtempSync(join(tmpdir(), 'remotelab-session-template-'));
process.env.HOME = home;

const workspace = join(home, 'workspace');
mkdirSync(workspace, { recursive: true });

const {
  applyTemplateToSession,
  createSession,
  getHistory,
  killAll,
  renameSession,
  saveSessionAsTemplate,
  submitHttpMessage,
} = await import('./chat/session-manager.mjs');
const {
  appendEvents,
  setContextHead,
} = await import('./chat/history.mjs');
const {
  getRunManifest,
} = await import('./chat/runs.mjs');

try {
  const source = await createSession(workspace, 'missing-tool', 'Source template session', {
    systemPrompt: 'Stay inside the saved subtask template.',
    group: 'Templates',
    description: 'Saved template source session for app-template coverage.',
  });

  await appendEvents(source.id, [
    {
      type: 'message',
      role: 'user',
      content: 'Load the whole template context once.',
      timestamp: 1,
    },
    {
      type: 'message',
      role: 'assistant',
      content: 'The warm base context is ready.',
      timestamp: 2,
    },
    {
      type: 'tool_use',
      toolName: 'shell',
      toolInput: 'ls -la',
      timestamp: 3,
    },
    {
      type: 'tool_result',
      toolName: 'shell',
      output: 'total 0',
      exitCode: 0,
      timestamp: 4,
    },
  ]);

  await setContextHead(source.id, {
    mode: 'summary',
    summary: 'This template covers the warmed subtask context.',
    activeFromSeq: 2,
    compactedThroughSeq: 2,
    updatedAt: '2026-03-12T00:00:00.000Z',
    source: 'test',
  });

  const template = await saveSessionAsTemplate(source.id, 'Warmed subtask');
  assert.ok(template?.id, 'saving a session as a template should create a template');
  assert.equal(template.name, 'Warmed subtask');
  assert.equal(template.tool, 'missing-tool');
  assert.equal(template.systemPrompt, 'Stay inside the saved subtask template.');
  assert.ok(template.templateContext?.sourceSessionUpdatedAt, 'saved templates should track the source session freshness timestamp');
  assert.match(template.templateContext?.content || '', /This template covers the warmed subtask context\./);
  assert.match(template.templateContext?.content || '', /ls -la/);

  const target = await createSession(workspace, 'codex', 'Fresh session', {
    group: 'Templates',
    description: 'Target session for applying a saved template.',
  });
  const applied = await applyTemplateToSession(target.id, template.id);
  assert.ok(applied, 'template should apply to a fresh session');
  assert.equal(applied.sourceId, 'chat', 'applying a template should not rewrite the session source');
  assert.equal(applied.templateId, template.id, 'session should keep the template id');
  assert.equal(applied.templateName, 'Warmed subtask', 'session should keep the template display name');
  assert.equal(applied.systemPrompt, 'Stay inside the saved subtask template.', 'template prompt should be applied');
  assert.equal(applied.tool, 'missing-tool', 'template tool should be applied to the session');

  const targetHistory = await getHistory(target.id);
  const templateEvent = targetHistory.find((event) => event.type === 'template_context');
  assert.ok(templateEvent, 'applying a template should append a hidden template context event');
  assert.equal(templateEvent.templateName, 'Warmed subtask');
  assert.equal(templateEvent.templateId, template.id);
  assert.equal(templateEvent.templateFreshness, 'current', 'fresh templates should record a current freshness state');
  assert.match(templateEvent.content, /This template covers the warmed subtask context\./);

  const outcome = await submitHttpMessage(target.id, 'Continue from the saved base.', [], {
    requestId: 'req_template_apply',
    queueIfBusy: false,
  });
  const manifest = await getRunManifest(outcome.run.id);
  assert.match(manifest?.prompt || '', /Applied template context: Warmed subtask/);
  assert.match(manifest?.prompt || '', /This template covers the warmed subtask context\./);
  assert.match(manifest?.prompt || '', /Stay inside the saved subtask template\./);

  await new Promise((resolve) => setTimeout(resolve, 20));
  const renamedSource = await renameSession(source.id, 'Source template session refreshed');
  assert.equal(renamedSource?.name, 'Source template session refreshed', 'source session refresh should update its metadata timestamp');

  const staleTarget = await createSession(workspace, 'codex', 'Fresh session after drift', {
    group: 'Templates',
    description: 'Target session for stale saved-template coverage.',
  });
  const staleApplied = await applyTemplateToSession(staleTarget.id, template.id);
  assert.ok(staleApplied, 'stale templates should still be applicable');

  const staleHistory = await getHistory(staleTarget.id);
  const staleTemplateEvent = staleHistory.find((event) => event.type === 'template_context');
  assert.ok(staleTemplateEvent, 'stale template application should still create a template context event');
  assert.equal(staleTemplateEvent.templateFreshness, 'stale', 'template application should flag stale snapshots');

  const staleOutcome = await submitHttpMessage(staleTarget.id, 'Continue, but be careful about drift.', [], {
    requestId: 'req_template_apply_stale',
    queueIfBusy: false,
  });
  const staleManifest = await getRunManifest(staleOutcome.run.id);
  assert.match(staleManifest?.prompt || '', /Template freshness warning/);
  assert.match(staleManifest?.prompt || '', /historical bootstrap context only/);
  assert.match(staleManifest?.prompt || '', /Re-read current files and notes before making changes\./);

  console.log('test-session-template-apps: ok');
} finally {
  killAll();
  rmSync(home, { recursive: true, force: true });
}
