#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-apps-builtins-'));
process.env.HOME = tempHome;
process.env.CHAT_PORT = '7692';
process.env.REMOTELAB_CONFIG_DIR = join(tempHome, 'instance-config');

const appsModule = await import(pathToFileURL(join(repoRoot, 'chat', 'apps.mjs')).href);

const {
  BASIC_CHAT_APP_ID,
  CREATE_APP_APP_ID,
  DEFAULT_APP_ID,
  EMAIL_APP_ID,
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
    ['chat', 'email', 'app_basic_chat', 'app_create_app'],
    'built-in apps should include connector scopes plus shipped starter apps',
  );
  assert.equal(DEFAULT_APP_ID, 'chat');
  assert.equal(EMAIL_APP_ID, 'email');
  assert.equal(BASIC_CHAT_APP_ID, 'app_basic_chat');
  assert.equal(CREATE_APP_APP_ID, 'app_create_app');
  assert.equal(isBuiltinAppId('Chat'), true);
  assert.equal(isBuiltinAppId('Email'), true);
  assert.equal(isBuiltinAppId('app_basic_chat'), true);
  assert.equal(isBuiltinAppId('app_create_app'), true);
  assert.equal(isBuiltinAppId('app_video_cut'), false);
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

  const basicChatApp = await getApp(BASIC_CHAT_APP_ID);
  assert.equal(basicChatApp?.id, BASIC_CHAT_APP_ID);
  assert.equal(basicChatApp?.builtin, true);
  assert.equal(basicChatApp?.templateSelectable, true);
  assert.equal(basicChatApp?.shareEnabled, false);
  assert.equal(basicChatApp?.shareToken, undefined);

  const createAppStarter = await getApp(CREATE_APP_APP_ID);
  assert.equal(createAppStarter?.id, CREATE_APP_APP_ID);
  assert.equal(createAppStarter?.builtin, true);
  assert.equal(createAppStarter?.templateSelectable, true);
  assert.equal(createAppStarter?.tool, 'codex');
  assert.equal(createAppStarter?.shareEnabled, false);
  assert.equal(createAppStarter?.shareToken, undefined);
  assert.match(createAppStarter?.systemPrompt || '', /POST \/api\/apps|PATCH \/api\/apps/i);
  assert.match(createAppStarter?.systemPrompt || '', /share link|\/app\/\{shareToken\}|other people/i);
  assert.match(createAppStarter?.systemPrompt || '', /http:\/\/127\.0\.0\.1:7692/);
  assert.match(
    createAppStarter?.systemPrompt || '',
    new RegExp(`${join(tempHome, 'instance-config', 'auth.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  );
  assert.match(createAppStarter?.welcomeMessage || '', /SOP|工作流|RemoteLab App/i);
  assert.match(createAppStarter?.welcomeMessage || '', /SOP|工作流/i);
  assert.match(createAppStarter?.welcomeMessage || '', /分享给别人的链接|分享方式|share/i);

  assert.equal(await getApp('feishu'), null);
  assert.equal(await getApp('app_video_cut'), null, 'Video Cut should no longer ship as a built-in app');

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
  assert.equal(defaultToolApp.tool, 'codex', 'new apps should default to CodeX');

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
