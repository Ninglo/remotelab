#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const template = readFileSync(join(repoRoot, 'templates', 'chat.html'), 'utf8');
const css = readFileSync(join(repoRoot, 'static', 'chat', 'task-center.css'), 'utf8');
const script = readFileSync(join(repoRoot, 'static', 'chat', 'task-center.js'), 'utf8');
const compose = readFileSync(join(repoRoot, 'static', 'chat', 'compose.js'), 'utf8');

assert.match(template, /class="app-rail-button" id="tabTasks"[^>]*data-i18n-title="nav\.tasks"/, 'Tasks must be a first-class application-rail destination');
assert.match(template, /<nav class="app-rail"[^>]*>[\s\S]*id="tabSessions"[\s\S]*id="tabAgents"[\s\S]*id="tabTasks"[\s\S]*id="tabSettings"[\s\S]*<\/nav>/, 'global destinations should live in one compact navigation rail');
assert.match(template, /id="taskCenterPanel"/, 'Task Center needs its own management panel');
assert.ok(
  template.indexOf('class="app-workspace"') < template.indexOf('id="taskCenterPanel"')
    && template.indexOf('id="taskCenterPanel"') < template.indexOf('<!-- Chat area -->'),
  'Task Center must render in the shared application workspace outside the ordinary Session transcript',
);
assert.match(template, /id="taskCenterForm" hidden/, 'Task creation should use progressive disclosure');
assert.match(template, /value="fixed_session"/, 'UI must offer a fixed Session execution mode');
assert.match(template, /value="new_session"/, 'UI must offer an independent Session execution mode');
assert.match(template, /value="remotelab"/, 'UI must configure RemoteLab-only result delivery independently');
assert.match(template, /value="source_conversation"/, 'UI must configure connected-source delivery independently');
assert.match(template, /id="taskCenterFilter"/, 'UI must expose task lifecycle filtering');

assert.match(css, /\.task-center-panel\s*\{[^}]*padding:\s*0/s, 'Task Center should own the full panel canvas');
assert.match(css, /\.task-center-list\s*\{[^}]*display:\s*grid/s, 'Task cards should use a stable vertical grid');
assert.match(css, /grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(100%,\s*440px\),\s*1fr\)\)/, 'wide Task Center workspaces should use their available width');
assert.match(css, /@media \(max-width:\s*720px\)/, 'mobile layouts need an explicit visual breakpoint');
assert.match(css, /@media \(max-width:\s*720px\)[\s\S]*\.task-center-grid\s*\{[^}]*grid-template-columns:\s*1fr/s, 'form columns should stack on narrow screens');
assert.match(css, /overflow-wrap:\s*anywhere/, 'long task and Session names must not overflow cards');

assert.match(compose, /showingTasks = activeTab === "tasks"/, 'tab navigation must activate the Task Center panel');
assert.match(compose, /resolvedSessionWorkspace\.hidden = !showingSessions/, 'workspace switching must hide the Session UI without navigating away');
assert.match(compose, /RemoteLabTaskCenter\?\.onTabShown/, 'opening Tasks must refresh its read model');
assert.match(script, /\/api\/automation-tasks/, 'Task Center must use the unified API');
assert.match(script, /scheduledAt = parsed\.toISOString\(\)/, 'local date input must be normalized before submission');
assert.match(script, /globalScope\.confirm/, 'terminal cancellation needs a user confirmation');
assert.doesNotMatch(script, /\.innerHTML\s*=/, 'task content should not be rendered through innerHTML');

console.log('Task Center UI structure and responsive visual contract tests passed.');
