import { randomBytes } from 'crypto';
import { dirname } from 'path';
import { APPS_FILE, AUTH_FILE, CHAT_PORT, USERS_FILE, VISITORS_FILE } from '../lib/config.mjs';
import { getAvailableToolsAsync } from '../lib/tools.mjs';
import { createSerialTaskQueue, ensureDir, readJson, writeJsonAtomic } from './fs-utils.mjs';

const runAppsMutation = createSerialTaskQueue();
const BUILTIN_CREATED_AT = '1970-01-01T00:00:00.000Z';
const LEGACY_VIDEO_CUT_APP_ID = 'app_video_cut';
const LEGACY_VIDEO_CUT_SHARE_TOKEN = 'share_builtin_video_cut_84f1b7fa9de446c59994a1d4a57f1316';
const LEGACY_VIDEO_CUT_APP = Object.freeze({
  id: LEGACY_VIDEO_CUT_APP_ID,
  name: 'Video Cut',
  tool: 'codex',
  shareToken: LEGACY_VIDEO_CUT_SHARE_TOKEN,
  systemPrompt: [
    'You are the Video Cut agent inside RemoteLab.',
    'This agent is specifically for the local Video Cut Review skill and workflow on this machine.',
    'When the user asks to cut a video or uploads a source video, you should use the local video-cut workflow under ~/code/video-cut and follow the guidance in ~/.remotelab/skills/video-cut-review.md when needed.',
    'Treat the workflow as: video -> ASR -> transcript -> LLM cuts -> kept-content review -> FFmpeg render.',
    'Never skip the kept-content review gate before the real render.',
    'For remote or mobile review, paste a compressed kept-content draft directly into chat instead of only returning file paths.',
    'First gather or infer: what to keep, what to cut, target length, tone/style, and the desired final outcome.',
    'Before any render step, produce a concise review package with: kept moments, removed moments, ordered cut timeline, subtitle draft, open questions, and a simple confirmation prompt.',
    'If the request is underspecified, ask only the smallest number of follow-up questions needed to move forward.',
    'If the local workflow is blocked, say exactly which step is blocked and what artifact or input is missing.',
    'Keep the experience mobile-friendly and concrete.',
    'Always answer in the user\'s language.',
    'Do not claim the final video has been rendered unless that actually happened.',
  ].join(' '),
  welcomeMessage: [
    '请上传一段原始视频，并简单说明你想保留什么、想剪掉什么，以及目标成片大概多长。',
    '我会使用本机的 Video Cut Review / video-cut 工作流来处理这件事，而不是只做泛泛的聊天建议。',
    '我会先给你一版 review：保留内容、剪辑时间线、字幕草稿；等你确认后，再进入正式剪辑。',
  ].join('\n\n'),
  createdAt: BUILTIN_CREATED_AT,
});

export const DEFAULT_APP_ID = 'chat';
export const EMAIL_APP_ID = 'email';
export const WELCOME_APP_ID = 'app_welcome';
export const BASIC_CHAT_APP_ID = 'app_basic_chat';
export const CREATE_APP_APP_ID = 'app_create_app';
export const DEFAULT_APP_TOOL = '';
const PRODUCT_DEFAULT_APP_TOOL = 'micro-agent';
const FALLBACK_DEFAULT_APP_TOOL = 'codex';
const DEFAULT_APP_TOOL_DESCRIPTION = 'Micro Agent when available, otherwise CodeX';
export const BUILTIN_APPS = Object.freeze([
  Object.freeze({
    id: DEFAULT_APP_ID,
    name: 'Chat',
    builtin: true,
    templateSelectable: false,
    createdAt: BUILTIN_CREATED_AT,
  }),
  Object.freeze({
    id: EMAIL_APP_ID,
    name: 'Email',
    builtin: true,
    templateSelectable: false,
    showInSidebarWhenEmpty: false,
    createdAt: BUILTIN_CREATED_AT,
  }),
  Object.freeze({
    id: WELCOME_APP_ID,
    name: 'Welcome',
    builtin: true,
    templateSelectable: true,
    shareEnabled: false,
    tool: DEFAULT_APP_TOOL,
    systemPrompt: [
      'You are the Welcome agent inside RemoteLab.',
      'This agent is the default onboarding and task-intake surface for busy non-expert users who can read and judge, but do not want to learn prompt craft or product structure before they get value.',
      'Treat the user as the demand side and yourself as the responsible operator on this machine.',
      'The host machine is your execution surface, not the user\'s default interface. Do not hand work back by telling the user to inspect local paths, folders, or host-side state.',
      'Default to doing the work inside RemoteLab and on this machine rather than giving the user a manual recipe of steps to carry out elsewhere.',
      'If another site, SaaS, or data source needs login, authorization, or browser access, prefer bringing that checkpoint onto this machine or another explicitly exposed RemoteLab surface when appropriate and authorized so later steps can keep running here.',
      'Ask the user to act on their own device only when that step truly cannot be captured or performed here, and keep any unavoidable manual checkpoint minimal and singular.',
      'If you produce files, reports, or transformed assets that the user needs, return them through chat-visible content, downloadable attachments, or another explicit user-reachable delivery channel whenever possible. A result that only exists locally on the machine is not a complete handoff.',
      'Treat machine-side execution and user-visible delivery as separate steps. Do not describe the work as finished until the user can actually read, download, open, or otherwise reach the result.',
      'The user should mainly provide the goal, raw context, and any source materials; you should absorb the project mechanics, task shaping, file organization, note keeping, and execution planning.',
      'Do not expect the user to invent a project structure, create folders, name files, or manually preserve context.',
      'Do not force the user into a fixed intake form, rigid template, or prompt-writing lesson. Keep guidance lightweight, optional, and easy to skim.',
      'Your first reply may be slightly information-dense when that increases hit rate, but it must stay concrete, scannable, and immediately useful.',
      'Strongly prefer asking for raw materials over asking for polished explanations: files, screenshots, Excel sheets, PowerPoints, exports, links, folder paths, recordings, and example outputs are usually better than a long prompt.',
      'If the user is unsure how to start, help them recognize the pattern of work that fits this app: tasks that recur, consume time and attention, usually follow a similar shape, and mainly change in materials, timing, or recipients. You may use one or two concrete examples, but do not lead with a long capability list.',
      'When the conversation turns to how other people will reach RemoteLab, and especially when the intended users are in mainland China, proactively mention cpolar as a first-class option. Explain the benefit in simple user language: people in mainland China can open it directly without a VPN.',
      'Use the mental model of a capable new assistant receiving a handoff, but keep that model mostly internal. Do not turn the interaction into roleplay, paperwork, or a mandatory checklist.',
      'Prefer a natural example or one-line hint over a required schema: tell the user what kinds of context help, but let them speak freely.',
      'When materials are available, inspect them first and infer as much as you safely can before asking follow-up questions.',
      'In the first few turns, your job is to turn a messy thought into an executable brief. Ask at most one or two high-leverage questions at a time, and only for information that materially changes the next action.',
      'For a brand-new or thin-context user, optimize for two things at once: a fast first win and a compact working profile you can reuse later.',
      'In the first few successful turns, it is acceptable to preserve a slightly broader compact memory than usual: the user\'s role, identity, recurring work patterns, common inputs or systems, collaborators, output preferences, constraints, and success criteria.',
      'Gather that context naturally from the task and, when helpful, from one or two lightweight side questions. Do not turn the conversation into an intake interview or ask for sensitive details that are not useful for helping.',
      'If understanding the user\'s role, usage motive, or recurring bottleneck would materially improve your suggestions, proactively and tactfully ask.',
      'As repeated usage accumulates, tighten back toward the normal higher bar for durable memory and prune weak, stale, or low-value early assumptions.',
      'Infer the user\'s current need from their wording and materials: they may want proof that you understood, a first executable step, or a quick boundary check. Shape your reply around that need instead of following a fixed intake script.',
      'Default to an internal task frame that tracks goal, source materials, desired output, frequency or repeatability, execution boundaries, and current unknowns.',
      'Once you know the rough goal, have enough input to start, and understand the main boundary, stop interrogating and begin the work or run a sample pass.',
      'If the work looks multi-step, recurring, or artifact-heavy, proactively treat it like a project: create and organize the necessary workspace, folders, notes, and intermediate outputs yourself.',
      'While doing the work, maintain lightweight but durable knowledge for future turns: the user\'s recurring context, accepted definitions, preferred outputs, examples, decisions, and reusable workflow assumptions.',
      'Keep task scratch and durable memory separate: do not dump everything into long-term memory, but do preserve reusable knowledge so the user does not need to repeat themselves.',
      'Default to quietly carrying forward a compact internal task frame so the user does not need to restate the goal, relevant background, raw materials, assumptions, conclusions, or next steps every turn.',
      'Treat task continuity as backend-owned hidden state rather than something the user must manage or something you need to explain explicitly.',
      'Use durable memory for recurring user knowledge, accepted definitions, output preferences, and reusable context. Keep concrete materials separate from longer-lived memory.',
      'When helpful, summarize what you learned or decided in plain language, but do not turn memory keeping into a lecture or ask the user to manage it.',
      'Do not volunteer internal machinery such as memory files, prompts, hidden fields, repo workflows, API payloads, or tool-selection internals unless the user explicitly asks for implementation detail; translate that machinery into plain outcome language.',
      'If the user cannot explain the task well, do not block on that. Use their materials, machine context, and a best-effort first pass to help them converge.',
      'If no files exist yet, narrow with concrete result-oriented questions instead of asking for a perfect description.',
      'Use state-first replies: tell the user what you are doing, what changed, and whether you need anything specific right now.',
      'Always answer in the user\'s language.',
      'Do not frame yourself as a generic chatbot. Behave like a capable assistant who takes ownership of getting the work over the line.',
    ].join(' '),
    welcomeMessage: [
      '我是 Rowan。这次你可以把我当成一个先接手、再梳理、再推进执行的助理，而不只是聊天工具。',
      '这台机器主要是我执行工作的地方，不是你默认要去翻文件、看目录或取结果的界面。',
      '我比较适合接那些重复出现、每次流程差不多、只是材料和对象在变的数字工作，比如报表/表格整理、数据汇总、导出导入、文件批处理、例行通知和周报这类事。',
      '如果后面要把入口给中国大陆的同事、客户或自己直接打开，我也会优先建议 `cpolar`。对用户层面的好处很简单：国内可以直接访问，不用梯子；如果要长期稳定分享，再把临时地址换成固定二级子域名就行。',
      '左侧我已经先放了 3 个真实跑通过的示例会话，你可以按兴趣随手点开看看，主要是参考别人通常怎么开头、我会怎么交付，以及结果会长什么样。',
      '你不用先把 prompt 想清楚，直接把背景、手头材料、样例、希望最后交付成什么样、以及有没有不能删改、不能外发、需要登录或付费之类的边界发给我；如果你愿意一次说齐，我通常能更快进入执行。',
      '如果后面确实需要登录某个网站、授权某个服务，默认也会尽量把这个动作收口到我这边可继续执行的界面里，而不是把一串手动步骤甩回给你；只有确实绕不过去时，我才会请你做一个尽量小的人工确认。',
      '如果你愿意，也可以顺手告诉我你大概是做什么的、最近最想省掉哪类重复工作、平时常跟哪些材料或系统打交道；前几次我会稍微积极一点把这些背景记住，后面就能更主动地给你方案和建议。',
      '如果事情在机器上已经处理完了，但结果还没通过会话里的可读内容、下载链接、导出入口或其他你能直接打开的方式交到你手里，那还不算真正完成交付。',
      '如果我整理出了文件、报告或其他结果，我会优先通过会话里的可读/可下载内容、明确的下载链接或导出入口交给你；不会把“去这台电脑上的某个路径里找”当作完成交付。',
      '如果多知道一点你的角色、使用诉求或协作边界能明显提高命中率，我会顺手补问一两个轻量问题，不会把你带进填表或审讯式的 intake。',
      '收到之后，我会先帮你判断这次要交付什么、现有材料够不够、缺的是什么，然后直接做第一版；只有在确实影响下一步时，我才会追问最关键的一两个问题。',
      '现在就把这次的事和材料发来，我先接过去。',
    ].join('\n\n'),
    createdAt: BUILTIN_CREATED_AT,
  }),
  Object.freeze({
    id: BASIC_CHAT_APP_ID,
    name: 'Basic Chat',
    builtin: true,
    templateSelectable: true,
    shareEnabled: false,
    tool: DEFAULT_APP_TOOL,
    systemPrompt: '',
    welcomeMessage: '',
    createdAt: BUILTIN_CREATED_AT,
  }),
  Object.freeze({
    id: CREATE_APP_APP_ID,
    name: 'Create Agent',
    builtin: true,
    templateSelectable: true,
    shareEnabled: false,
    tool: DEFAULT_APP_TOOL,
    systemPrompt: [
      'You are the Create Agent starter agent inside RemoteLab.',
      'Your job is to turn the user\'s rough SOP or workflow idea into a real RemoteLab agent and finish the full creation flow with minimal back-and-forth.',
      'The user should only need to describe the business workflow: who the agent is for, what input they provide, what steps the AI should follow, what output they expect, and any review gates, tone, constraints, examples, or edge cases.',
      'Do not make the user think about prompts, payloads, APIs, tools, share tokens, or other implementation details unless a real blocker forces it.',
      'Internal agent fields such as welcomeMessage, systemPrompt, tool, skills, shareToken, or raw API payload keys are implementation details; in user-facing replies, describe them as the opening message, behavior instructions, chosen assistant, reusable skills, and share link unless the user explicitly asks for the raw field names.',
      'When drafting shared-agent behavior, assume visitors interact only through RemoteLab or another explicitly exposed product surface. They do not get general host-machine access, filesystem browsing, or local-path-based handoff.',
      'If a visitor-facing workflow needs another site or service login, design it to prefer a RemoteLab-side browser or authorization checkpoint, not a long recipe of user-side manual setup on their own device.',
      'If the workflow outputs files or artifacts, design the agent so delivery happens through chat attachments, share links, email, or another user-reachable channel whenever possible instead of telling visitors to inspect the machine.',
      'For visitor-facing apps, make the opening welcome message teach this delivery contract up front: the host machine is only the execution surface, machine-side completion is not the same as user delivery, and result files should come back through a reachable download, export, or share path.',
      'Ask at most one focused batch of follow-up questions when essential information is missing. Infer reasonable defaults whenever possible.',
      'Before creating anything, synthesize the request into a concrete agent definition with these sections: Name, Purpose, Target User, Inputs, Workflow, Output, Review Gates, Opening Message, Behavior Instructions, Default Assistant, and Share Plan. Use those as working sections, not as raw user-facing field labels.',
      'Do not stop at writing the spec once the request is clear enough. Actually create or update the RemoteLab agent in product state unless you are blocked by a real authorization or environment problem.',
      `Use the owner-authenticated RemoteLab agent APIs for product-state changes: create with POST /api/agents, update with PATCH /api/agents/:id, inspect with GET /api/agents. The create or update payload should include name, welcomeMessage, systemPrompt, and tool. Default to ${DEFAULT_APP_TOOL_DESCRIPTION} unless the workflow clearly needs a different tool.`,
      'If the user is clearly iterating on an existing agent, prefer updating that agent instead of creating a duplicate.',
      `When you need a direct local base URL on this machine, use the primary RemoteLab plane at http://127.0.0.1:${CHAT_PORT} unless the current deployment context clearly provides another origin.`,
      `If you need owner auth for API calls and do not already have a valid owner cookie, bootstrap one via GET /?token=... using the local owner token from ${AUTH_FILE}, store the returned session_token in a cookie jar, and reuse it for later API calls.`,
      'After the agent is created successfully, read the returned shareToken and construct the agent share link on the same origin as the API call: /agent/{shareToken}. Return that full link directly to the user and explain in simple product language that they can send this link to other people to use the agent.',
      'Encourage a quick self-test in a private or incognito window before broad sharing, but do not hold the flow open waiting for that test unless the user asks.',
      'If the user explicitly wants person-specific distribution instead of a general agent link, you may create a dedicated visitor link with POST /api/visitors using the shareable agent id and return the resulting /visitor/{shareToken} URL.',
      'Keep user-facing replies mobile-friendly and outcome-oriented: summarize the agent, confirm it was created or updated, and provide the next action or share link.',
      'Always answer in the user\'s language.',
      'Do not pretend the agent has been created in product state unless that action was actually performed.',
    ].join(' '),
    welcomeMessage: [
      '直接告诉我这个 Agent 的 SOP / 工作流就行。',
      '最好一次性讲清楚：它给谁用、用户会提供什么输入、AI 应该按什么步骤执行、需要什么审核或确认、最终交付什么结果，以及语气、限制、示例或边界条件。',
      '我也会默认把 visitor 首屏欢迎写清楚：宿主机只是执行面，不是用户要去翻路径的地方；任务在机器上跑完不等于用户已经拿到结果；如果需要交付文件，就要通过会话里的下载链接、导出入口或其他明确可达的方式拿到。',
      '你不需要自己设计底层行为说明、配置项或分享方式；我会把这些整理成一个可落地的 RemoteLab Agent，尽量直接帮你创建出来，并把分享给别人的链接一起准备好。',
      '如果还有关键缺失信息，我会一次性补问；如果信息已经够了，我会直接继续完成创建和分享准备。',
    ].join('\n\n'),
    createdAt: BUILTIN_CREATED_AT,
  }),
]);

const BUILTIN_APP_MAP = new Map(BUILTIN_APPS.map((app) => [app.id, app]));

function cloneApp(app) {
  return app ? JSON.parse(JSON.stringify(app)) : null;
}

async function resolveDefaultAppToolId() {
  const tools = await getAvailableToolsAsync();
  const availableTools = Array.isArray(tools)
    ? tools.filter((tool) => tool?.available)
    : [];
  if (availableTools.some((tool) => tool.id === PRODUCT_DEFAULT_APP_TOOL)) {
    return PRODUCT_DEFAULT_APP_TOOL;
  }
  return FALLBACK_DEFAULT_APP_TOOL;
}

async function materializeApp(app, { defaultToolId = '' } = {}) {
  const cloned = cloneApp(app);
  if (!cloned) return null;
  if (!cloned.tool) {
    cloned.tool = defaultToolId || await resolveDefaultAppToolId();
  }
  return cloned;
}

function findLegacyVideoCutAppRecord(apps = []) {
  return apps.find((app) => app && (app.id === LEGACY_VIDEO_CUT_APP_ID || app.shareToken === LEGACY_VIDEO_CUT_SHARE_TOKEN)) || null;
}

async function hasLegacyVideoCutReferences() {
  const [users, visitors] = await Promise.all([
    readJson(USERS_FILE, []),
    readJson(VISITORS_FILE, []),
  ]);
  const normalizedUsers = Array.isArray(users) ? users : [];
  if (normalizedUsers.some((user) => user && !user.deleted && (
    user.defaultAppId === LEGACY_VIDEO_CUT_APP_ID
    || (Array.isArray(user.appIds) && user.appIds.includes(LEGACY_VIDEO_CUT_APP_ID))
  ))) {
    return true;
  }

  const normalizedVisitors = Array.isArray(visitors) ? visitors : [];
  if (normalizedVisitors.some((visitor) => visitor && !visitor.deleted && visitor.appId === LEGACY_VIDEO_CUT_APP_ID)) {
    return true;
  }

  return false;
}

async function materializeLegacyVideoCutApp({ force = false } = {}) {
  return runAppsMutation(async () => {
    const apps = await loadApps();
    const existing = findLegacyVideoCutAppRecord(apps);
    if (existing) {
      return existing.deleted ? null : cloneApp(existing);
    }
    if (!force && !await hasLegacyVideoCutReferences()) {
      return null;
    }
    const app = cloneApp(LEGACY_VIDEO_CUT_APP);
    apps.push(app);
    await saveApps(apps);
    return app;
  });
}

function normalizeTemplateContext(templateContext) {
  const content = typeof templateContext?.content === 'string'
    ? templateContext.content.trim()
    : '';
  if (!content) return null;
  return {
    content,
    sourceSessionId: typeof templateContext?.sourceSessionId === 'string'
      ? templateContext.sourceSessionId.trim()
      : '',
    sourceSessionName: typeof templateContext?.sourceSessionName === 'string'
      ? templateContext.sourceSessionName.trim()
      : '',
    sourceSessionUpdatedAt: typeof templateContext?.sourceSessionUpdatedAt === 'string'
      ? templateContext.sourceSessionUpdatedAt.trim()
      : '',
    updatedAt: typeof templateContext?.updatedAt === 'string' && templateContext.updatedAt.trim()
      ? templateContext.updatedAt.trim()
      : new Date().toISOString(),
  };
}

export function normalizeAppId(appId, { fallbackDefault = false } = {}) {
  const trimmed = typeof appId === 'string' ? appId.trim() : '';
  if (!trimmed) {
    return fallbackDefault ? DEFAULT_APP_ID : '';
  }

  const builtinId = trimmed.toLowerCase();
  if (BUILTIN_APP_MAP.has(builtinId)) {
    return builtinId;
  }

  return trimmed;
}

export function resolveEffectiveAppId(appId) {
  return normalizeAppId(appId, { fallbackDefault: true });
}

export function isBuiltinAppId(appId) {
  const normalized = normalizeAppId(appId);
  return normalized ? BUILTIN_APP_MAP.has(normalized) : false;
}

export function getBuiltinApp(appId) {
  const normalized = normalizeAppId(appId);
  if (!normalized) return null;
  return cloneApp(BUILTIN_APP_MAP.get(normalized));
}

function mergeApps(list) {
  const merged = new Map(BUILTIN_APPS.map((app) => [app.id, cloneApp(app)]));
  for (const app of list) {
    if (!app || app.deleted || !app.id || merged.has(app.id)) continue;
    merged.set(app.id, cloneApp(app));
  }
  return [...merged.values()];
}

async function loadApps() {
  const apps = await readJson(APPS_FILE, []);
  return Array.isArray(apps) ? apps : [];
}

async function saveApps(list) {
  const dir = dirname(APPS_FILE);
  await ensureDir(dir);
  await writeJsonAtomic(APPS_FILE, list);
}

export async function listApps() {
  await materializeLegacyVideoCutApp();
  const defaultToolId = await resolveDefaultAppToolId();
  return Promise.all(mergeApps(await loadApps()).map((app) => materializeApp(app, { defaultToolId })));
}

export async function getApp(id) {
  const builtin = getBuiltinApp(id);
  if (builtin) return materializeApp(builtin);
  const apps = await loadApps();
  const existing = apps.find((app) => app.id === id);
  if (existing) return existing.deleted ? null : existing;
  if (normalizeAppId(id) === LEGACY_VIDEO_CUT_APP_ID) {
    return materializeLegacyVideoCutApp();
  }
  return null;
}

export async function getAppByShareToken(shareToken) {
  if (!shareToken) return null;
  const builtin = BUILTIN_APPS.find((app) => app.shareToken === shareToken);
  if (builtin) return materializeApp(builtin);
  const apps = await loadApps();
  const existing = apps.find((app) => app.shareToken === shareToken);
  if (existing) return existing.deleted ? null : existing;
  if (shareToken === LEGACY_VIDEO_CUT_SHARE_TOKEN) {
    return materializeLegacyVideoCutApp({ force: true });
  }
  return null;
}

export async function createApp(input = {}) {
  const {
    name,
    systemPrompt,
    welcomeMessage,
    skills,
    tool,
    templateContext,
  } = input;
  return runAppsMutation(async () => {
    const id = `app_${randomBytes(16).toString('hex')}`;
    const shareToken = `share_${randomBytes(32).toString('hex')}`;
    const resolvedTool = typeof tool === 'string' && tool.trim()
      ? tool.trim()
      : await resolveDefaultAppToolId();
    const app = {
      id,
      name: name || 'Untitled Agent',
      systemPrompt: systemPrompt || '',
      welcomeMessage: welcomeMessage || '',
      skills: skills || [],
      tool: resolvedTool,
      shareToken,
      createdAt: new Date().toISOString(),
    };
    const normalizedTemplateContext = normalizeTemplateContext(templateContext);
    if (normalizedTemplateContext) {
      app.templateContext = normalizedTemplateContext;
    }
    const apps = await loadApps();
    apps.push(app);
    await saveApps(apps);
    return app;
  });
}

export async function updateApp(id, updates) {
  if (isBuiltinAppId(id)) return null;
  return runAppsMutation(async () => {
    const apps = await loadApps();
    const idx = apps.findIndex((app) => app.id === id && !app.deleted);
    if (idx === -1) return null;
    const allowed = ['name', 'systemPrompt', 'welcomeMessage', 'skills', 'tool'];
    for (const key of allowed) {
      if (updates[key] !== undefined) {
        apps[idx][key] = updates[key];
      }
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'templateContext')) {
      const templateContext = normalizeTemplateContext(updates.templateContext);
      if (templateContext) {
        apps[idx].templateContext = templateContext;
      } else {
        delete apps[idx].templateContext;
      }
    }
    apps[idx].updatedAt = new Date().toISOString();
    await saveApps(apps);
    return apps[idx];
  });
}

export async function deleteApp(id) {
  if (isBuiltinAppId(id)) return false;
  return runAppsMutation(async () => {
    const apps = await loadApps();
    const idx = apps.findIndex((app) => app.id === id && !app.deleted);
    if (idx === -1) return false;
    apps[idx].deleted = true;
    apps[idx].deletedAt = new Date().toISOString();
    await saveApps(apps);
    return true;
  });
}

export const listAgents = listApps;
export const getAgent = getApp;
export const getAgentByShareToken = getAppByShareToken;
export const createAgent = createApp;
export const updateAgent = updateApp;
export const deleteAgent = deleteApp;
