#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-apps-builtins-'));
process.env.HOME = tempHome;

const appsModule = await import(pathToFileURL(join(repoRoot, 'chat', 'apps.mjs')).href);

const {
  DEFAULT_APP_ID,
  createApp,
  deleteApp,
  getApp,
  isBuiltinAppId,
  listApps,
  updateApp,
} = appsModule;

try {
  const initial = await listApps();
  assert.deepEqual(
    initial.slice(0, 5).map((app) => app.id),
    ['chat', 'feishu', 'email', 'github', 'automation'],
    'built-in apps should be listed first for owner filters',
  );
  assert.equal(DEFAULT_APP_ID, 'chat');
  assert.equal(isBuiltinAppId('Chat'), true);
  assert.equal(isBuiltinAppId('github'), true);
  assert.equal(isBuiltinAppId('custom-app'), false);

  const chatApp = await getApp('chat');
  assert.equal(chatApp?.id, 'chat');
  assert.equal(chatApp?.name, 'Chat');
  assert.equal(chatApp?.builtin, true);

  const larkApp = await getApp('feishu');
  assert.equal(larkApp?.name, 'Lark');

  const emailApp = await getApp('email');
  assert.equal(emailApp?.name, 'Email');

  const automationApp = await getApp('automation');
  assert.equal(automationApp?.name, 'Automation');
  assert.equal(automationApp?.builtin, true);

  const custom = await createApp({
    name: 'Docs Portal',
    systemPrompt: 'Help with docs only.',
    welcomeMessage: 'Welcome!',
    skills: [],
    tool: 'codex',
  });
  assert.match(custom.id, /^app_[0-9a-f]+$/);

  const defaultToolApp = await createApp({
    name: 'Default Tool App',
    systemPrompt: 'Use the product default.',
    welcomeMessage: '',
    skills: [],
  });
  assert.equal(defaultToolApp.tool, 'codex', 'new apps should default to CodeX/codex');

  const afterCreate = await listApps();
  assert.equal(afterCreate.some((app) => app.id === custom.id), true);
  assert.equal(afterCreate.some((app) => app.id === defaultToolApp.id), true);

  assert.equal(await updateApp('chat', { name: 'Owner Console' }), null);
  assert.equal(await deleteApp('github'), false);
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}

console.log('test-apps-builtins: ok');
