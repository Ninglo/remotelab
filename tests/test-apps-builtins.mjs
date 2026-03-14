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
  CREATE_APP_APP_ID,
  DEFAULT_APP_ID,
  EMAIL_APP_ID,
  VIDEO_CUT_APP_ID,
  createApp,
  deleteApp,
  getApp,
  getAppByShareToken,
  isBuiltinAppId,
  listApps,
  updateApp,
} = appsModule;

try {
  const initial = await listApps();
  assert.deepEqual(
    initial.map((app) => app.id),
    ['chat', 'email', 'app_create_app', 'app_video_cut'],
    'built-in apps should include connector scopes plus shipped starter apps',
  );
  assert.equal(DEFAULT_APP_ID, 'chat');
  assert.equal(EMAIL_APP_ID, 'email');
  assert.equal(CREATE_APP_APP_ID, 'app_create_app');
  assert.equal(VIDEO_CUT_APP_ID, 'app_video_cut');
  assert.equal(isBuiltinAppId('Chat'), true);
  assert.equal(isBuiltinAppId('Email'), true);
  assert.equal(isBuiltinAppId('app_create_app'), true);
  assert.equal(isBuiltinAppId('app_video_cut'), true);
  assert.equal(isBuiltinAppId('github'), false);
  assert.equal(isBuiltinAppId('custom-app'), false);

  const chatApp = await getApp('chat');
  assert.equal(chatApp?.id, 'chat');
  assert.equal(chatApp?.name, 'Chat');
  assert.equal(chatApp?.builtin, true);
  assert.equal(chatApp?.templateSelectable, false);

  const emailApp = await getApp('email');
  assert.equal(emailApp?.id, 'email');
  assert.equal(emailApp?.name, 'Email');
  assert.equal(emailApp?.builtin, true);
  assert.equal(emailApp?.templateSelectable, false);
  assert.equal(emailApp?.showInSidebarWhenEmpty, false);

  const createAppStarter = await getApp(CREATE_APP_APP_ID);
  assert.equal(createAppStarter?.id, CREATE_APP_APP_ID);
  assert.equal(createAppStarter?.builtin, true);
  assert.equal(createAppStarter?.templateSelectable, true);
  assert.equal(createAppStarter?.tool, 'codex');
  assert.match(createAppStarter?.welcomeMessage || '', /创建什么 App|app specification/i);

  const videoCutApp = await getApp(VIDEO_CUT_APP_ID);
  assert.equal(videoCutApp?.id, VIDEO_CUT_APP_ID);
  assert.equal(videoCutApp?.builtin, true);
  assert.equal(videoCutApp?.templateSelectable, true);
  assert.equal(videoCutApp?.tool, 'codex');
  assert.match(videoCutApp?.welcomeMessage || '', /上传一段原始视频|uploaded source video/i);
  assert.equal((await getAppByShareToken(videoCutApp?.shareToken))?.id, VIDEO_CUT_APP_ID);

  assert.equal(await getApp('feishu'), null);

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
  assert.equal(await updateApp('email', { name: 'Mailbox' }), null);
  assert.equal(await deleteApp('chat'), false);
  assert.equal(await deleteApp('email'), false);
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}

console.log('test-apps-builtins: ok');
