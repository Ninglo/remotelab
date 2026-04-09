#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-apps-builtins-'));
const configDir = join(tempHome, 'instance-config');
const localBin = join(tempHome, 'bin');
mkdirSync(configDir, { recursive: true });
mkdirSync(localBin, { recursive: true });
writeFileSync(join(localBin, 'fake-codex'), '#!/usr/bin/env bash\nexit 0\n', 'utf8');
chmodSync(join(localBin, 'fake-codex'), 0o755);
writeFileSync(
  join(configDir, 'tools.json'),
  JSON.stringify([
    {
      id: 'micro-agent',
      name: 'Micro Agent',
      visibility: 'private',
      toolProfile: 'micro-agent',
      command: 'fake-codex',
      runtimeFamily: 'codex-json',
      models: [{ id: 'gpt-5.4-mini', label: 'gpt-5.4-mini' }],
      reasoning: { kind: 'none', label: 'Thinking' },
    },
  ], null, 2),
  'utf8',
);
process.env.HOME = tempHome;
process.env.CHAT_PORT = '7692';
process.env.REMOTELAB_CONFIG_DIR = configDir;
process.env.PATH = `${localBin}:${process.env.PATH || ''}`;

const appsModule = await import(pathToFileURL(join(repoRoot, 'chat', 'apps.mjs')).href);

const {
  DEFAULT_APP_ID,
  EMAIL_APP_ID,
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
    initial.map((app) => app.id),
    ['chat', 'email'],
    'built-in apps should only include current connector/source scopes',
  );
  assert.equal(DEFAULT_APP_ID, 'chat');
  assert.equal(EMAIL_APP_ID, 'email');
  assert.equal(isBuiltinAppId('Chat'), true);
  assert.equal(isBuiltinAppId('Email'), true);
  assert.equal(isBuiltinAppId('app_welcome'), false);
  assert.equal(isBuiltinAppId('app_basic_chat'), false);
  assert.equal(isBuiltinAppId('app_create_app'), false);
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

  assert.equal(await getApp('app_welcome'), null);
  assert.equal(await getApp('app_basic_chat'), null);
  assert.equal(await getApp('app_create_app'), null);

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
    name: 'Default Tool Agent',
    systemPrompt: 'Use the product default.',
    welcomeMessage: '',
    skills: [],
  });
  assert.equal(defaultToolApp.tool, 'micro-agent', 'new agents should default to Micro Agent when available');

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
