import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { basename, dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { CHAT_PORT, INSTANCE_ROOT, MAINLAND_PUBLIC_BASE_URL, PUBLIC_BASE_URL } from '../lib/config.mjs';
import { buildCalendarSubscriptionChannels, getFeedInfo } from '../lib/connector-calendar-feed.mjs';
import { loadMailboxRuntimeRegistry } from '../lib/mailbox-runtime-registry.mjs';

import { BASIC_CHAT_APP_ID, WELCOME_APP_ID, getApp } from './apps.mjs';
import { publishLocalFileAssetFromPath } from './file-assets.mjs';
import { appendEvents, readEventsAfter } from './history.mjs';
import { messageEvent } from './normalizer.mjs';
import { SESSION_ENTRY_MODE_READ } from './session-entry-mode.mjs';
import {
  applyTemplateToSession,
  createSession,
  getSession,
  listSessions,
  setSessionPinned,
  updateSessionEntryMode,
  updateSessionGrouping,
  updateSessionLastReviewedAt,
} from './session-manager.mjs';

export const OWNER_BOOTSTRAP_WELCOME_SESSION_EXTERNAL_TRIGGER_ID = 'owner_bootstrap:welcome';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP_ASSETS_DIR = join(MODULE_DIR, 'bootstrap-assets');
const RAW_SPREADSHEET_ASSET_PATH = join(BOOTSTRAP_ASSETS_DIR, 'sales-march.raw.xlsx');
const CLEANED_SPREADSHEET_ASSET_PATH = join(BOOTSTRAP_ASSETS_DIR, 'sales-march.cleaned.xlsx');
const CLEANUP_NOTES_ASSET_PATH = join(BOOTSTRAP_ASSETS_DIR, 'sales-march.notes.md');
const DIGEST_SHOWCASE_ASSET_PATH = join(BOOTSTRAP_ASSETS_DIR, 'ai-coding-agent-digest.sample.md');
const OWNER_BOOTSTRAP_FILE_SHOWCASE_EXTERNAL_TRIGGER_ID = 'owner_bootstrap:showcase:file_cleanup';
const OWNER_BOOTSTRAP_DIGEST_SHOWCASE_EXTERNAL_TRIGGER_ID = 'owner_bootstrap:showcase:digest_email_delivery';
const OWNER_BOOTSTRAP_INSTANCE_EMAIL_EXTERNAL_TRIGGER_ID = 'owner_bootstrap:showcase:instance_email';
const OWNER_BOOTSTRAP_CALENDAR_SUBSCRIBE_EXTERNAL_TRIGGER_ID = 'owner_bootstrap:guide:calendar_subscribe';

async function safeReadJson(filePath, fallbackValue = null) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return fallbackValue;
  }
}

function normalizeMailboxName(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
    : '';
}

function buildGuestMailboxAddress(instanceName, ownerIdentity) {
  const normalizedInstanceName = normalizeMailboxName(instanceName);
  const localPart = typeof ownerIdentity?.localPart === 'string' ? ownerIdentity.localPart.trim() : '';
  const domain = typeof ownerIdentity?.domain === 'string' ? ownerIdentity.domain.trim() : '';
  const addressMode = typeof ownerIdentity?.instanceAddressMode === 'string' ? ownerIdentity.instanceAddressMode.trim() : '';
  if (!normalizedInstanceName || !localPart || !domain) return '';
  if (addressMode === 'local_part') {
    return `${normalizedInstanceName}@${domain}`;
  }
  return `${localPart}+${normalizedInstanceName}@${domain}`;
}

async function resolveCurrentMailboxAddress() {
  const normalizedPort = Number.parseInt(`${CHAT_PORT || 0}`, 10) || 0;
  const registry = await loadMailboxRuntimeRegistry({ homeDir: homedir() });
  const matchedRuntime = registry.find((record) => Number.parseInt(`${record?.port || 0}`, 10) === normalizedPort) || null;
  const runtimeMailboxAddress = typeof matchedRuntime?.mailboxAddress === 'string'
    ? matchedRuntime.mailboxAddress.trim()
    : '';
  if (runtimeMailboxAddress) return runtimeMailboxAddress;

  const ownerIdentity = await safeReadJson(join(homedir(), '.config', 'remotelab', 'agent-mailbox', 'identity.json'), null);
  const guestMailboxAddress = buildGuestMailboxAddress(basename(INSTANCE_ROOT || ''), ownerIdentity);
  if (guestMailboxAddress) return guestMailboxAddress;
  const ownerMailboxAddress = typeof ownerIdentity?.address === 'string' ? ownerIdentity.address.trim() : '';
  return ownerMailboxAddress;
}

function buildInboundEmailSetupHint(mailboxAddress) {
  if (mailboxAddress) {
    return [
      '补充一个和邮件相关的提示：如果你想测试“发邮件到这个实例会自动开新会话”这条能力，先把你会用来发送的邮箱告诉我，我会先把它设成允许发件人；不然安全机制会先把邮件拦掉。',
      `这个实例当前的收件地址是 \`${mailboxAddress}\`。`,
    ].join('\n\n');
  }

  return '补充一个和邮件相关的提示：如果你想测试“发邮件到这个实例会自动开新会话”这条能力，先把你会用来发送的邮箱告诉我，我会先把它设成允许发件人；不然安全机制会先把邮件拦掉。';
}

function buildEmailShowcaseIntro(mailboxAddress) {
  if (mailboxAddress) {
    return [
      '这个示例基于我刚验证过的真实链路。',
      `这个实例当前的收件地址是 \`${mailboxAddress}\`。你直接给它发邮件，左侧会自动多出一个新会话。`,
      '正式测试前，先把你会用来发送的邮箱告诉我，我会先把它设成允许发件人；不然安全机制会先把邮件拦掉。',
      '下面这条用户消息，就是邮件进入会话后实际会出现的格式。',
    ].join('\n\n');
  }

  return [
    '这个示例基于我刚验证过的真实链路。',
    '实例启用邮箱接入后，你直接给它发邮件，左侧会自动多出一个新会话。',
    '正式测试前，先把你会用来发送的邮箱告诉我，我会先把它设成允许发件人；不然安全机制会先把邮件拦掉。',
    '下面这条用户消息，就是邮件进入会话后实际会出现的格式。',
  ].join('\n\n');
}

function buildEmailShowcaseUserMessage(mailboxAddress) {
  return [
    'Inbound email.',
    '- From: jiujianian@gmail.com',
    '- Subject: 真实能力验证邮件',
    '- Date: (no date)',
    '- Message-ID: (no message id)',
    '',
    'User message:',
    '这是一次真实能力验证邮件。',
    '',
    mailboxAddress
      ? `如果链路正常，发到 ${mailboxAddress} 的邮件会自动进到一个新会话里。`
      : '如果链路正常，发到这个实例地址的邮件会自动进到一个新会话里。',
  ].join('\n');
}

function buildDigestShowcaseIntro() {
  return [
    '这是一个已经实测跑通过的样例。',
    '这个流程不是只展示“能做摘要”或“能发邮件”其中一项，而是把两件事接成一条真实交付链路：先整理最近行业热点，再把结果发到指定邮箱。',
  ].join('\n\n');
}

async function resolveCalendarSubscriptionUrls() {
  try {
    const feedInfo = await getFeedInfo();
    if (!feedInfo?.feedToken) return null;
    const channels = buildCalendarSubscriptionChannels({
      feedToken: feedInfo.feedToken,
      mainlandBaseUrl: MAINLAND_PUBLIC_BASE_URL,
      publicBaseUrl: PUBLIC_BASE_URL,
      preferredBaseUrl: MAINLAND_PUBLIC_BASE_URL || PUBLIC_BASE_URL,
    });
    return channels.variants.length > 0 ? channels : null;
  } catch {
    return null;
  }
}

function buildCalendarGuideMessages(calendarUrls) {
  if (!calendarUrls) return null;
  const variantLines = calendarUrls.variants.flatMap((variant) => {
    const title = variant.kind === 'mainland'
      ? '**中国大陆推荐：**'
      : variant.kind === 'public'
        ? '**海外 / 备用：**'
        : '**订阅入口：**';
    return [
      `${title}\n[点击订阅日历](${variant.webcalUrl || variant.httpsUrl})`,
      `手动订阅地址：\n${variant.httpsUrl}`,
    ];
  });

  return [
    {
      role: 'assistant',
      content: [
        '这个实例支持日历订阅功能。我创建的所有日程事件都会写入一个 iCal 订阅源，你只需要订阅一次，之后所有新事件都会自动同步到你的日历 app 里。',
        ...variantLines,
        '点击上面的链接后，系统会弹出"订阅日历？"的确认框，确认即可。',
        '**各平台操作方式：**',
        '- **iOS**：设置 → 日历 → 账户 → 添加账户 → 其他 → 添加已订阅的日历 → 粘贴地址',
        '- **macOS**：日历 → 文件 → 新建日历订阅 → 粘贴地址',
        '- **Android**：推荐使用 [One Calendar](https://play.google.com/store/apps/details?id=com.degenhardt.android.onecalendar)，支持导入订阅链接',
        '**建议设置：** 订阅后将刷新频率改为"每 5 分钟"，这样新事件会更快同步到你的日历中。',
        '订阅完成后，你可以在任何会话中告诉我要加什么日程，事件会自动出现在你的日历里。',
      ].join('\n\n'),
    },
  ];
}

async function getOwnerBootstrapSessionDefinitions() {
  const [mailboxAddress, calendarUrls] = await Promise.all([
    resolveCurrentMailboxAddress(),
    resolveCalendarSubscriptionUrls(),
  ]);

  return [
    {
      templateId: WELCOME_APP_ID,
      externalTriggerId: OWNER_BOOTSTRAP_WELCOME_SESSION_EXTERNAL_TRIGGER_ID,
      name: 'Welcome',
      entryMode: SESSION_ENTRY_MODE_READ,
      pinned: true,
      sidebarOrder: 1,
      extraMessages: [
        {
          role: 'assistant',
          content: buildInboundEmailSetupHint(mailboxAddress),
        },
      ],
    },
    {
      templateId: BASIC_CHAT_APP_ID,
      externalTriggerId: OWNER_BOOTSTRAP_FILE_SHOWCASE_EXTERNAL_TRIGGER_ID,
      name: '[示例] 上传一份表格，我把清洗后的文件回给你',
      entryMode: SESSION_ENTRY_MODE_READ,
      pinned: true,
      sidebarOrder: 2,
      messages: [
        {
          role: 'assistant',
          content: [
            '这是一个已经实测跑通过的样例。',
            '你可以直接点附件看交付长什么样：上面是用户上传的原始表，下面是我回给用户的结果文件。',
          ].join('\n\n'),
        },
        {
          role: 'user',
          content: '我先上传一份样例销售表。你可以把它理解成用户真实会发来的那种“日期混乱、联系人和电话混在一起、还有重复客户”的表。',
          attachments: [
            {
              localPath: RAW_SPREADSHEET_ASSET_PATH,
              originalName: 'sales-march.raw.xlsx',
              mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              renderAs: 'file',
            },
          ],
        },
        {
          role: 'assistant',
          content: [
            '这条链路我已经实际跑通过了。下面两个附件可以直接下载：一个是清洗后的表，一个是清洗说明。',
            '你把自己的表发来后，我会先按同样方式跑第一版，再决定有没有必要固化成重复流程。',
          ].join('\n\n'),
          attachments: [
            {
              localPath: CLEANED_SPREADSHEET_ASSET_PATH,
              originalName: 'sales-march.cleaned.xlsx',
              mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              renderAs: 'file',
            },
            {
              localPath: CLEANUP_NOTES_ASSET_PATH,
              originalName: '清洗说明.md',
              mimeType: 'text/markdown',
              renderAs: 'file',
            },
          ],
        },
      ],
    },
    {
      templateId: BASIC_CHAT_APP_ID,
      externalTriggerId: OWNER_BOOTSTRAP_DIGEST_SHOWCASE_EXTERNAL_TRIGGER_ID,
      name: '[示例] 汇总最近行业热点，并把摘要发到指定邮箱',
      entryMode: SESSION_ENTRY_MODE_READ,
      pinned: true,
      sidebarOrder: 3,
      messages: [
        {
          role: 'assistant',
          content: buildDigestShowcaseIntro(),
        },
        {
          role: 'user',
          content: '我想跟踪 AI 编程助手 / remote agent 这类行业热点。先给我一版今天的摘要，并发到我的收件邮箱；如果格式合适，再改成每天早上 8 点。',
        },
        {
          role: 'assistant',
          content: [
            '这条链路我已经实际跑通过了。我先把今天这份摘要发到指定邮箱，同时把同一份正文放成附件供你直接看。',
            '如果你确认格式和收件都没问题，我再把它固化成每天自动发。',
          ].join('\n\n'),
          attachments: [
            {
              localPath: DIGEST_SHOWCASE_ASSET_PATH,
              originalName: 'AI 编程助手热点摘要（样例）.md',
              mimeType: 'text/markdown',
              renderAs: 'file',
            },
          ],
        },
      ],
    },
    {
      templateId: BASIC_CHAT_APP_ID,
      externalTriggerId: OWNER_BOOTSTRAP_INSTANCE_EMAIL_EXTERNAL_TRIGGER_ID,
      name: '[示例] 发一封邮件到这个实例，会自动开一个新会话',
      entryMode: SESSION_ENTRY_MODE_READ,
      pinned: true,
      sidebarOrder: 4,
      messages: [
        {
          role: 'assistant',
          content: buildEmailShowcaseIntro(mailboxAddress),
        },
        {
          role: 'user',
          content: buildEmailShowcaseUserMessage(mailboxAddress),
        },
        {
          role: 'assistant',
          content: '这就是邮件进来后的实际起点。你自己试的时候，不用先进来手动新建聊天；邮件到达后我会先把它挂成单独会话，再继续处理。',
        },
      ],
    },
    ...(calendarUrls ? [{
      templateId: BASIC_CHAT_APP_ID,
      externalTriggerId: OWNER_BOOTSTRAP_CALENDAR_SUBSCRIBE_EXTERNAL_TRIGGER_ID,
      name: '[引导] 订阅日历，接收 AI 创建的日程事件',
      entryMode: SESSION_ENTRY_MODE_READ,
      pinned: true,
      sidebarOrder: 5,
      messages: buildCalendarGuideMessages(calendarUrls),
    }] : []),
  ];
}

const LEGACY_WELCOME_SHOWCASE_HINT = [
  '另外，左侧现在已经给你放了 3 个真实跑通过的示例会话：表格清洗回传、行业热点摘要发邮箱、以及发邮件进实例自动开新会话。',
  '你可以按兴趣点开看看，主要是参考：用户通常怎么开头、我会怎么交付，以及结果会长什么样。',
  '觉得哪个最像你的情况，就直接照着那个方式把你的版本发给我。',
].join('\n\n');

function getStarterMessagesForDefinition(definition, app) {
  return Array.isArray(definition.messages) && definition.messages.length > 0
    ? definition.messages
    : (app?.welcomeMessage ? [{ role: 'assistant', content: app.welcomeMessage }] : []);
}

function resolveBootstrapSessionEntryMode(session, definition) {
  if (definition?.entryMode !== SESSION_ENTRY_MODE_READ) {
    return '';
  }
  if (
    definition?.templateId === WELCOME_APP_ID
    && typeof session?.welcomeOnboardingRetiredAt === 'string'
    && session.welcomeOnboardingRetiredAt.trim()
  ) {
    return '';
  }
  return SESSION_ENTRY_MODE_READ;
}

async function applyBootstrapSessionPresentation(session, definition) {
  let nextSession = session;
  if (Number.isInteger(definition.sidebarOrder) && definition.sidebarOrder > 0) {
    nextSession = await updateSessionGrouping(nextSession.id, { sidebarOrder: definition.sidebarOrder }) || nextSession;
  }
  nextSession = await updateSessionEntryMode(
    nextSession.id,
    resolveBootstrapSessionEntryMode(nextSession, definition),
  ) || nextSession;
  if (definition.pinned === true) {
    nextSession = await setSessionPinned(nextSession.id, true) || nextSession;
  }
  if (nextSession?.updatedAt) {
    nextSession = await updateSessionLastReviewedAt(nextSession.id, nextSession.updatedAt) || nextSession;
  }
  return nextSession;
}

async function loadMessageContents(sessionId) {
  const events = await readEventsAfter(sessionId, 0, { includeBodies: true });
  return events
    .filter((event) => event?.type === 'message' && typeof event?.content === 'string')
    .map((event) => event.content.trim())
    .filter(Boolean);
}

async function appendMissingBootstrapMessages(sessionId, messages = [], existingContents = null) {
  const contents = Array.isArray(existingContents) ? existingContents : await loadMessageContents(sessionId);
  const pendingMessages = messages.filter((message) => {
    const content = typeof message?.content === 'string' ? message.content.trim() : '';
    return content && !contents.includes(content);
  });
  if (pendingMessages.length === 0) return 0;
  const pendingEvents = await buildMessageEvents(sessionId, pendingMessages);
  if (pendingEvents.length === 0) return 0;
  await appendEvents(sessionId, pendingEvents);
  return pendingEvents.length;
}

async function backfillWelcomeGuideMessages(session, mailboxAddress) {
  const existingContents = await loadMessageContents(session.id);
  const followups = [];
  if (!existingContents.some((content) => /3 个真实跑通过的示例会话|发邮件进实例自动开新会话/u.test(content))) {
    followups.push({ role: 'assistant', content: LEGACY_WELCOME_SHOWCASE_HINT });
  }
  if (!existingContents.some((content) => /允许发件人|安全机制会先把邮件拦掉/u.test(content))) {
    followups.push({ role: 'assistant', content: buildInboundEmailSetupHint(mailboxAddress) });
  }
  await appendMissingBootstrapMessages(session.id, followups, existingContents);
}

async function publishMessageAttachments(sessionId, attachments = []) {
  const publishedAttachments = [];
  for (const attachment of attachments) {
    if (!(attachment && typeof attachment === 'object')) continue;
    const published = await publishLocalFileAssetFromPath({
      sessionId,
      localPath: attachment.localPath,
      originalName: attachment.originalName,
      mimeType: attachment.mimeType,
      createdBy: 'assistant',
    });
    publishedAttachments.push({
      assetId: published.id,
      originalName: attachment.originalName || published.originalName,
      mimeType: attachment.mimeType || published.mimeType,
      ...(Number.isInteger(published?.sizeBytes) && published.sizeBytes > 0 ? { sizeBytes: published.sizeBytes } : {}),
      ...(attachment.renderAs ? { renderAs: attachment.renderAs } : {}),
    });
  }
  return publishedAttachments;
}

async function buildMessageEvents(sessionId, messages = []) {
  const events = [];
  for (const message of messages) {
    if (!(message && typeof message.content === 'string' && message.content.trim())) continue;
    const attachments = Array.isArray(message.attachments) && message.attachments.length > 0
      ? await publishMessageAttachments(sessionId, message.attachments)
      : [];
    events.push(messageEvent(
      message.role === 'user' ? 'user' : 'assistant',
      message.content,
      attachments,
    ));
  }
  return events;
}

async function createOwnerBootstrapSession(definition, { appendLegacyWelcomeHint = false } = {}) {
  const template = await getApp(definition.templateId);
  if (!template?.id) return null;

  const usePlainStarterSession = definition.externalTriggerId === OWNER_BOOTSTRAP_WELCOME_SESSION_EXTERNAL_TRIGGER_ID;

  let session = await createSession('~', template.tool || 'codex', definition.name || template.name || 'Session', {
    sourceId: 'chat',
    sourceName: 'Chat',
    externalTriggerId: definition.externalTriggerId,
    ...(usePlainStarterSession
      ? {
          systemPrompt: typeof template.systemPrompt === 'string' ? template.systemPrompt : '',
          templateId: template.id,
          templateName: template.name || '',
        }
      : {}),
  });
  if (!usePlainStarterSession) {
    session = await applyTemplateToSession(session.id, template.id) || session;
  }
  session = await getSession(session.id) || session;

  if (Number(session?.messageCount || 0) === 0) {
    const starterMessages = getStarterMessagesForDefinition(definition, template);
    const extraMessages = Array.isArray(definition.extraMessages) ? definition.extraMessages : [];
    const starterEvents = await buildMessageEvents(session.id, [...starterMessages, ...extraMessages]);
    if (starterEvents.length > 0) {
      await appendEvents(session.id, starterEvents);
      session = await getSession(session.id) || session;
    }
  } else if (appendLegacyWelcomeHint && definition.externalTriggerId === OWNER_BOOTSTRAP_WELCOME_SESSION_EXTERNAL_TRIGGER_ID) {
    const appendedEvents = await buildMessageEvents(session.id, [
      { role: 'assistant', content: LEGACY_WELCOME_SHOWCASE_HINT },
      ...(Array.isArray(definition.extraMessages) ? definition.extraMessages : []),
    ]);
    if (appendedEvents.length > 0) {
      await appendEvents(session.id, appendedEvents);
      session = await getSession(session.id) || session;
    }
  }

  return applyBootstrapSessionPresentation(session, definition);
}

export async function backfillOwnerBootstrapSessions() {
  const [ownerBootstrapSessions, mailboxAddress] = await Promise.all([
    getOwnerBootstrapSessionDefinitions(),
    resolveCurrentMailboxAddress(),
  ]);
  const ownerSessions = (await listSessions({
    includeArchived: true,
  }));
  const activeOwnerSessions = ownerSessions.filter((session) => session?.archived !== true);
  const sessionsByTrigger = new Map(
    activeOwnerSessions
      .filter((session) => typeof session?.externalTriggerId === 'string' && session.externalTriggerId.trim())
      .map((session) => [session.externalTriggerId.trim(), session]),
  );

  const created = [];
  const updated = [];
  let welcomeSession = sessionsByTrigger.get(OWNER_BOOTSTRAP_WELCOME_SESSION_EXTERNAL_TRIGGER_ID) || null;

  for (const definition of ownerBootstrapSessions) {
    let session = sessionsByTrigger.get(definition.externalTriggerId) || null;
    if (!session) {
      session = await createOwnerBootstrapSession(definition);
      if (!session) continue;
      sessionsByTrigger.set(definition.externalTriggerId, session);
      created.push(definition.name);
    } else {
      session = await applyBootstrapSessionPresentation(session, definition);
      updated.push(definition.name);
    }

    if (definition.externalTriggerId === OWNER_BOOTSTRAP_WELCOME_SESSION_EXTERNAL_TRIGGER_ID) {
      await backfillWelcomeGuideMessages(session, mailboxAddress);
      welcomeSession = await getSession(session.id) || session;
    }
  }

  return {
    welcomeSession,
    created,
    updated,
  };
}

export async function ensureOwnerBootstrapSessions() {
  const ownerBootstrapSessions = await getOwnerBootstrapSessionDefinitions();
  const ownerSessions = (await listSessions({
    includeArchived: true,
  }));

  const activeOwnerSessions = ownerSessions.filter((session) => session?.archived !== true);
  const hasLegacyBlankWelcomeOnly = activeOwnerSessions.length === 1
    && activeOwnerSessions[0]?.externalTriggerId === OWNER_BOOTSTRAP_WELCOME_SESSION_EXTERNAL_TRIGGER_ID
    && Number(activeOwnerSessions[0]?.messageCount || 0) <= 1;

  if (activeOwnerSessions.length > 0 && !hasLegacyBlankWelcomeOnly) {
    return activeOwnerSessions[0];
  }

  let welcomeSession = null;
  for (const definition of ownerBootstrapSessions) {
    const session = await createOwnerBootstrapSession(definition, {
      appendLegacyWelcomeHint: hasLegacyBlankWelcomeOnly,
    });
    if (definition.externalTriggerId === OWNER_BOOTSTRAP_WELCOME_SESSION_EXTERNAL_TRIGGER_ID) {
      welcomeSession = session;
    }
  }

  return welcomeSession || activeOwnerSessions[0] || null;
}
