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
  BASIC_CHAT_APP_ID,
  CREATE_APP_APP_ID,
  DEFAULT_APP_ID,
  EMAIL_APP_ID,
  WELCOME_APP_ID,
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
    ['chat', 'email', 'app_welcome', 'app_basic_chat', 'app_create_app'],
    'built-in apps should include connector scopes plus shipped starter apps',
  );
  assert.equal(DEFAULT_APP_ID, 'chat');
  assert.equal(EMAIL_APP_ID, 'email');
  assert.equal(WELCOME_APP_ID, 'app_welcome');
  assert.equal(BASIC_CHAT_APP_ID, 'app_basic_chat');
  assert.equal(CREATE_APP_APP_ID, 'app_create_app');
  assert.equal(isBuiltinAppId('Chat'), true);
  assert.equal(isBuiltinAppId('Email'), true);
  assert.equal(isBuiltinAppId('app_welcome'), true);
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

  const welcomeApp = await getApp(WELCOME_APP_ID);
  assert.equal(welcomeApp?.id, WELCOME_APP_ID);
  assert.equal(welcomeApp?.builtin, true);
  assert.equal(welcomeApp?.templateSelectable, true);
  assert.equal(welcomeApp?.shareEnabled, false);
  assert.equal(welcomeApp?.shareToken, undefined);
  assert.equal(welcomeApp?.tool, 'micro-agent', 'Welcome should prefer Micro Agent when available');
  assert.match(welcomeApp?.systemPrompt || '', /raw materials|files, screenshots|PowerPoints/i);
  assert.match(welcomeApp?.systemPrompt || '', /fixed intake form|rigid template|prompt-writing lesson/i);
  assert.match(welcomeApp?.systemPrompt || '', /new assistant receiving a handoff|report or spreadsheet cleanup|exports and imports/i);
  assert.match(welcomeApp?.systemPrompt || '', /project mechanics|project structure|folders, notes/i);
  assert.match(welcomeApp?.systemPrompt || '', /durable knowledge|repeat themselves/i);
  assert.match(welcomeApp?.systemPrompt || '', /fast first win|compact working profile|recurring work patterns/i);
  assert.match(welcomeApp?.systemPrompt || '', /lightweight side questions|usage motive|recurring bottleneck/i);
  assert.match(welcomeApp?.systemPrompt || '', /internal task frame|backend-owned hidden state|concrete materials/i);
  assert.match(welcomeApp?.systemPrompt || '', /execution surface|local paths|complete handoff/i);
  assert.match(welcomeApp?.systemPrompt || '', /mainland China|cpolar|without a VPN/i);
  assert.match(welcomeApp?.systemPrompt || '', /inside RemoteLab and on this machine rather than giving the user a manual recipe/i);
  assert.match(welcomeApp?.systemPrompt || '', /login, authorization, or browser access|explicitly exposed RemoteLab surface/i);
  assert.match(welcomeApp?.systemPrompt || '', /machine-side execution and user-visible delivery as separate steps|read, download, open, or otherwise reach the result/i);
  assert.doesNotMatch(welcomeApp?.systemPrompt || '', /task_card|hidden <private>|mode, summary, goal/i);
  assert.match(welcomeApp?.welcomeMessage || '', /我是 Rowan|聊天工具|先接手、再梳理、再推进执行/u);
  assert.match(welcomeApp?.welcomeMessage || '', /执行工作的地方|翻文件|取结果的界面/u);
  assert.match(welcomeApp?.welcomeMessage || '', /报表\/表格整理|导出导入|文件批处理/u);
  assert.match(welcomeApp?.welcomeMessage || '', /cpolar|国内可以直接访问|不用梯子/u);
  assert.match(welcomeApp?.welcomeMessage || '', /prompt 想清楚|一次说齐|进入执行/u);
  assert.match(welcomeApp?.welcomeMessage || '', /登录某个网站|授权某个服务|尽量小的人工确认/u);
  assert.match(welcomeApp?.welcomeMessage || '', /大概是做什么的|最想省掉哪类重复工作|哪些材料或系统/u);
  assert.match(welcomeApp?.welcomeMessage || '', /还不算真正完成交付|交到你手里/u);
  assert.match(welcomeApp?.welcomeMessage || '', /下载链接|导出入口/u);
  assert.match(welcomeApp?.welcomeMessage || '', /可读\/可下载内容|某个路径里找/u);
  assert.match(welcomeApp?.welcomeMessage || '', /角色、使用诉求或协作边界|轻量问题|填表或审讯式/u);
  assert.match(welcomeApp?.welcomeMessage || '', /最关键的一两个问题|现在就把这次的事和材料发来/u);

  const basicChatApp = await getApp(BASIC_CHAT_APP_ID);
  assert.equal(basicChatApp?.id, BASIC_CHAT_APP_ID);
  assert.equal(basicChatApp?.builtin, true);
  assert.equal(basicChatApp?.templateSelectable, true);
  assert.equal(basicChatApp?.shareEnabled, false);
  assert.equal(basicChatApp?.shareToken, undefined);
  assert.equal(basicChatApp?.tool, 'micro-agent', 'Basic Chat should share the product default assistant');

  const createAppStarter = await getApp(CREATE_APP_APP_ID);
  assert.equal(createAppStarter?.id, CREATE_APP_APP_ID);
  assert.equal(createAppStarter?.builtin, true);
  assert.equal(createAppStarter?.templateSelectable, true);
  assert.equal(createAppStarter?.tool, 'micro-agent');
  assert.equal(createAppStarter?.shareEnabled, false);
  assert.equal(createAppStarter?.shareToken, undefined);
  assert.match(createAppStarter?.systemPrompt || '', /POST \/api\/agents|PATCH \/api\/agents/i);
  assert.match(createAppStarter?.systemPrompt || '', /share link|\/agent\/\{shareToken\}|other people/i);
  assert.match(createAppStarter?.systemPrompt || '', /visitors interact only through RemoteLab|local-path-based handoff/i);
  assert.match(createAppStarter?.systemPrompt || '', /visitor-facing workflow needs another site or service login|RemoteLab-side browser or authorization checkpoint/i);
  assert.match(createAppStarter?.systemPrompt || '', /chat attachments|share links|user-reachable channel/i);
  assert.match(createAppStarter?.systemPrompt || '', /opening welcome message teach this delivery contract|machine-side completion is not the same as user delivery|download, export, or share path/i);
  assert.match(createAppStarter?.systemPrompt || '', /welcomeMessage, systemPrompt, tool, skills, shareToken|implementation details/i);
  assert.match(createAppStarter?.systemPrompt || '', /Opening Message, Behavior Instructions, Default Assistant, and Share Plan|working sections, not as raw user-facing field labels/i);
  assert.match(createAppStarter?.systemPrompt || '', /http:\/\/127\.0\.0\.1:7692/);
  assert.match(
    createAppStarter?.systemPrompt || '',
    new RegExp(`${join(tempHome, 'instance-config', 'auth.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  );
  assert.match(createAppStarter?.welcomeMessage || '', /SOP|工作流|RemoteLab Agent/i);
  assert.match(createAppStarter?.welcomeMessage || '', /SOP|工作流/i);
  assert.match(createAppStarter?.welcomeMessage || '', /visitor 首屏欢迎|宿主机只是执行面|翻路径的地方/u);
  assert.match(createAppStarter?.welcomeMessage || '', /不等于用户已经拿到结果/u);
  assert.match(createAppStarter?.welcomeMessage || '', /下载链接|导出入口|明确可达/u);
  assert.match(createAppStarter?.welcomeMessage || '', /底层行为说明|配置项|分享方式/u);
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
