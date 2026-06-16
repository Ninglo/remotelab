#!/usr/bin/env node
import assert from 'assert/strict';

const {
  checkSessionContinuationNeed,
  executeContinuationPlan,
  isTrivialContinuationPlan,
  planSessionContinuations,
  shouldRunDispatch,
  shouldPrepareContinuationCheck,
} = await import('../chat/session-dispatch.mjs');
const {
  buildContinuationGatePrompt,
  buildContinuationPlannerPrompt,
} = await import('../chat/session-dispatch-prompt.mjs');

const previousDispatchSetting = process.env.REMOTELAB_SESSION_DISPATCH;

delete process.env.REMOTELAB_SESSION_DISPATCH;
assert.equal(
  shouldRunDispatch({ id: 'session-1' }, {}),
  false,
  'continuation planning should default to disabled when the env var is unset',
);

process.env.REMOTELAB_SESSION_DISPATCH = 'off';
assert.equal(
  shouldRunDispatch({ id: 'session-1' }, {}),
  false,
  'continuation planning should still honor an explicit off setting',
);

process.env.REMOTELAB_SESSION_DISPATCH = 'on';

assert.equal(
  shouldRunDispatch({ id: 'session-1' }, {
    internalOperation: 'reply_self_repair',
  }),
  false,
  'internal continuation turns should not re-enter continuation planning',
);

assert.equal(
  shouldRunDispatch({ id: 'session-1' }, {
    recordUserMessage: false,
    queueIfBusy: false,
  }),
  false,
  'follow-up turns without a recorded user message should not re-enter continuation planning',
);

assert.equal(
  shouldRunDispatch({ id: 'session-1' }, {}),
  true,
  'normal user turns should still be eligible for continuation planning',
);

assert.equal(
  shouldPrepareContinuationCheck({
    id: 'session-simple',
  }, ''),
  false,
  'empty messages should not enter continuation checking',
);

assert.equal(
  shouldPrepareContinuationCheck({
    id: 'session-simple',
  }, '继续把这个 bug 修掉。'),
  true,
  'ordinary single-track follow-ups should still enter continuation checking so stage 1 can decide whether heavy planning is needed',
);

assert.equal(
  shouldPrepareContinuationCheck({
    id: 'session-branch',
  }, '把 UI 卡片那条线单独拉出来，别继续和 planner 架构讨论混在一起。'),
  true,
  'explicit branch-off requests should also enter continuation checking through the same structural gate',
);

assert.equal(
  shouldPrepareContinuationCheck(null, 'anything'),
  false,
  'missing sessions should not enter continuation planning',
);

const gatePrompt = buildContinuationGatePrompt({
  currentSession: {
    id: 'session-source',
    name: '个人助手聊天',
    description: '同一个聊天框里会出现散漫的个人助手请求。',
  },
  currentTranscript: '[User]: 北京天气怎么样？\n\n[Assistant]: 今天北京晴。\n\n[User]: 明天下午提醒我开会。',
  message: '上海后天会下雨吗？',
});

assert.match(
  gatePrompt,
  /"same_workstream": the current session identity still fits\./,
  'gate prompt should define the stable same-workstream relation',
);

assert.match(
  gatePrompt,
  /"same_session_shift": the current session should still own this input, but the session's main visible frontier has materially shifted enough that later relabeling may be appropriate\./,
  'gate prompt should define the relabel-worthy same-session-shift relation',
);

assert.match(
  gatePrompt,
  /Default to "continue_direct" when uncertain\./,
  'gate prompt should explicitly bias weak evidence toward staying direct',
);

const directGateDecision = await checkSessionContinuationNeed({
  session: {
    id: 'session-source',
    name: '个人助手聊天',
    description: '同一个聊天框里会出现散漫的个人助手请求。',
  },
  message: '上海后天会下雨吗？',
  loadSessionHistory: async () => [
    { type: 'message', role: 'user', content: '北京天气怎么样？' },
    { type: 'message', role: 'assistant', content: '今天北京晴。' },
    { type: 'message', role: 'user', content: '明天下午提醒我开会。' },
  ],
  runPrompt: async () => '<hide>{"action":"continue_direct","workstreamRelation":"same_workstream","confidence":0.93,"reasoning":"这是一个简单的一次性提问。"}<\/hide>',
});

assert.equal(
  directGateDecision.action,
  'continue_direct',
  'simple one-off asks should stay on the direct path',
);
assert.equal(
  directGateDecision.workstreamRelation,
  'same_workstream',
  'simple one-off asks should not redefine the session workstream',
);

const escalatedGateDecision = await checkSessionContinuationNeed({
  session: {
    id: 'session-source',
    name: '会话分流复用判定',
    description: '梳理会话分流与复用判定逻辑。',
  },
  message: '把 UI 卡片那条线单独拉出来，别继续和 planner 架构讨论混在一起。',
  loadSessionHistory: async () => [
    { type: 'message', role: 'user', content: '我们是不是应该把分流和 delegate 统一成单一 planner？' },
    { type: 'message', role: 'assistant', content: '当前主线是会话分流机制本身。' },
  ],
  runPrompt: async () => '<hide>{"action":"needs_planning","workstreamRelation":"separate_workstream","confidence":0.91,"reasoning":"用户明确要求把相关子线单独拉出。"}<\/hide>',
});

assert.equal(
  escalatedGateDecision.action,
  'needs_planning',
  'explicit branch-off requests should escalate into full planning',
);
assert.equal(
  escalatedGateDecision.workstreamRelation,
  'separate_workstream',
  'explicit branch-off requests should be marked as a separate workstream',
);

const lowConfidenceGateDecision = await checkSessionContinuationNeed({
  session: {
    id: 'session-source',
    name: '会话分流复用判定',
    description: '梳理会话分流与复用判定逻辑。',
  },
  message: '顺手再聊聊别的吧。',
  loadSessionHistory: async () => [
    { type: 'message', role: 'user', content: '我们是不是应该把分流和 delegate 统一成单一 planner？' },
    { type: 'message', role: 'assistant', content: '当前主线是会话分流机制本身。' },
  ],
  runPrompt: async () => '<hide>{"action":"needs_planning","workstreamRelation":"separate_workstream","confidence":0.31,"reasoning":"也许应该规划一下。"}<\/hide>',
});

assert.equal(
  lowConfidenceGateDecision.action,
  'continue_direct',
  'low-confidence escalation should fall back to the cheap direct path',
);
assert.equal(
  lowConfidenceGateDecision.workstreamRelation,
  'same_workstream',
  'low-confidence workstream shifts should also fall back to the stable default relation',
);

const emptyTranscriptPlan = await planSessionContinuations({
  session: {
    id: 'session-empty',
    name: 'Restart',
    description: 'Empty session should not split on its first real message.',
  },
  message: 'slow run',
  loadSessionHistory: async () => [],
  runPrompt: async () => {
    throw new Error('planner prompt should not run for empty transcripts');
  },
});

assert.equal(
  isTrivialContinuationPlan(emptyTranscriptPlan),
  true,
  'empty sessions should short-circuit to a trivial continue plan before planning prompts run',
);

const plannerPrompt = buildContinuationPlannerPrompt({
  currentSession: {
    id: 'session-source',
    name: '个人助手聊天',
    description: '同一个聊天框里会出现散漫的个人助手请求。',
  },
  currentTranscript: '[User]: 北京天气怎么样？\n\n[Assistant]: 今天北京晴。\n\n[User]: 明天下午提醒我开会。',
  message: '上海后天会下雨吗？',
});

assert.match(
  plannerPrompt,
  /simple one-off ask .* should usually stay as "continue"/i,
  'planner prompt should explicitly bias simple one-off asks toward staying in the current session',
);

assert.match(
  plannerPrompt,
  /Topic shift alone is not enough for "fresh"/,
  'planner prompt should make topic shift alone insufficient for fresh session creation',
);

assert.match(
  plannerPrompt,
  /A simple time-based reminder or schedule update request should usually stay as "continue"/,
  'planner prompt should keep plain reminder asks in the current session',
);

assert.match(
  plannerPrompt,
  /Recurring feedback loops, scheduled reviews, "check my calendar and tell me what changed", or other future AI work.*may justify "fresh" or "fork"/,
  'planner prompt should distinguish recurring AI work from simple reminders',
);

const continuePlan = await planSessionContinuations({
  session: {
    id: 'session-source',
    name: '会话分流复用判定',
    description: '梳理会话分流与复用判定逻辑。',
  },
  message: '把兼容逻辑去掉这个策略，直接在当前分流流程里统一改掉。',
  loadSessionHistory: async () => [
    { type: 'message', role: 'user', content: '我们现在会话转发的机制是怎么实现的？' },
    { type: 'message', role: 'assistant', content: '当前实现里 dispatch 和 delegate 还没有彻底统一。' },
    { type: 'message', role: 'user', content: '那我们是不是应该把它统一成单一 planner？' },
  ],
  runPrompt: async () => '<hide>{"confidence":0.94,"reasoning":"这是当前主线的实现续写。","userVisibleSummary":"继续留在当前会话。","destinations":[{"mode":"continue","inheritanceProfile":"reuse_current_context","reasoning":"当前主线仍然拥有这条输入。","deliveryText":"把兼容逻辑去掉这个策略，直接在当前分流流程里统一改掉。"}]}</hide>',
});

assert.equal(continuePlan.destinations.length, 1, 'continue plan should return one destination');
assert.equal(continuePlan.destinations[0].mode, 'continue', 'continue plan should keep the current session');
assert.equal(isTrivialContinuationPlan(continuePlan), true, 'single continue destination should be treated as trivial');

const forkPlan = await planSessionContinuations({
  session: {
    id: 'session-source',
    name: '会话分流复用判定',
    description: '梳理会话分流与复用判定逻辑。',
  },
  message: '把 UI 卡片那条线单独拉出来，别继续和 planner 架构讨论混在一起。',
  loadSessionHistory: async () => [
    { type: 'message', role: 'user', content: '我们是不是应该把分流和 delegate 统一成单一 planner？' },
    { type: 'message', role: 'assistant', content: '当前主线是会话分流机制本身。' },
  ],
  runPrompt: async () => '<hide>{"confidence":0.95,"reasoning":"这是同一主题下应独立展开的子线。","userVisibleSummary":"当前输入应从主线里分出一个相关支线。","destinations":[{"mode":"fork","reasoning":"UI 展示和 planner 架构高度相关，但后续值得独立展开。","scopeFraming":"只讨论分流结果的 UI 呈现与卡片机制。","deliveryText":"整理分流结果的 UI 卡片与展示方案。","forwardedContext":"延续当前会话对 continuation mode 和 inheritance profile 的讨论结论。","titleHint":"分流结果卡片 UI"}]}</hide>',
});

assert.equal(forkPlan.destinations.length, 1, 'fork plan should return one destination');
assert.equal(forkPlan.destinations[0].mode, 'fork', 'planner should recognize a related branch');
assert.equal(forkPlan.destinations[0].inheritanceProfile, 'full_parent_context', 'fork should default to full parent context');

const mixedPlan = await planSessionContinuations({
  session: {
    id: 'session-source',
    name: '会话分流复用判定',
    description: '梳理会话分流与复用判定逻辑。',
  },
  message: '先把 planner schema 定下来，另外再新开一个会话整理下周出差行程。',
  loadSessionHistory: async () => [
    { type: 'message', role: 'user', content: '我们是不是应该把分流和 delegate 统一成单一 planner？' },
    { type: 'message', role: 'assistant', content: '当前主线是会话分流机制本身。' },
  ],
  runPrompt: async () => '<hide>{"confidence":0.91,"reasoning":"当前输入包含一个主线续写和一个新的独立工作流。","userVisibleSummary":"这轮输入会继续当前主线，同时拆出一个新会话处理无关事项。","destinations":[{"mode":"continue","reasoning":"planner schema 仍然属于当前主线。","scopeFraming":"继续收束 planner schema。","deliveryText":"把 planner schema 定下来。"},{"mode":"fresh","reasoning":"出差行程是独立工作流，不该继续塞在当前会话里。","scopeFraming":"这是一个新的出差安排整理会话。","deliveryText":"整理下周出差行程。","forwardedContext":"这条任务是从 planner 架构讨论中顺手分出来的独立事项。","titleHint":"下周出差行程"}]}</hide>',
});

assert.equal(mixedPlan.destinations.length, 2, 'mixed plan should allow multiple destinations');
assert.equal(mixedPlan.destinations[0].mode, 'continue', 'mixed plan should keep the main line in current session');
assert.equal(mixedPlan.destinations[1].mode, 'fresh', 'mixed plan should also allow a fresh session');
assert.equal(mixedPlan.destinations[1].inheritanceProfile, 'minimal_forwarded_context', 'fresh sessions should default to minimal forwarded context');
assert.equal(isTrivialContinuationPlan(mixedPlan), false, 'multiple destinations should not be treated as trivial');

const lowConfidenceSplitPlan = await planSessionContinuations({
  session: {
    id: 'session-source',
    name: '会话分流复用判定',
    description: '梳理会话分流与复用判定逻辑。',
  },
  message: '顺手再聊聊别的吧。',
  loadSessionHistory: async () => [
    { type: 'message', role: 'user', content: '我们是不是应该把分流和 delegate 统一成单一 planner？' },
    { type: 'message', role: 'assistant', content: '当前主线是会话分流机制本身。' },
  ],
  runPrompt: async () => '<hide>{"confidence":0.42,"reasoning":"也许可以拆一条新会话。","userVisibleSummary":"低置信度拆分。","destinations":[{"mode":"fresh","reasoning":"也许是新话题。","deliveryText":"顺手再聊聊别的吧。","forwardedContext":"低置信度推测。"}]}</hide>',
});

assert.equal(
  lowConfidenceSplitPlan.destinations[0].mode,
  'continue',
  'low-confidence non-trivial plans should fall back to continue',
);

const appendedEvents = [];
const submitted = [];
const createdSessions = [];
const preparedChildContexts = [];
let broadcastedSessionId = '';

const planningOutcome = await executeContinuationPlan({
  plan: mixedPlan,
  sourceSession: {
    id: 'session-source',
    folder: '/tmp/workspace',
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
    thinking: false,
    group: 'Product',
    description: '梳理会话分流复用判定逻辑。',
    sourceId: 'chat',
    sourceName: 'Chat',
    templateId: '',
    templateName: '',
    systemPrompt: '',
    activeAgreements: [],
    userId: '',
    userName: '',
    latestSeq: 12,
    rootSessionId: 'session-root',
  },
  sourceSessionId: 'session-source',
  message: '先把 planner schema 定下来，另外再新开一个会话整理下周出差行程。',
  images: [],
  options: {
    requestId: 'req-original',
    responseId: 'resp-original',
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  },
  createSession: async (folder, tool, name, extra) => {
    const session = {
      id: `child-${createdSessions.length + 1}`,
      folder,
      tool,
      name: name || `Child ${createdSessions.length + 1}`,
      ...extra,
    };
    createdSessions.push(session);
    return session;
  },
  submitMessage: async (sessionId, text, images, options) => {
    submitted.push({ sessionId, text, images, options });
    return {
      session: { id: sessionId, name: sessionId === 'session-source' ? 'Source Session' : '下周出差行程' },
      run: { id: `run-${submitted.length}` },
    };
  },
  appendEvent: async (sessionId, event) => {
    appendedEvents.push({ sessionId, event });
    return event;
  },
  broadcastInvalidation: (sessionId) => {
    broadcastedSessionId = sessionId;
  },
  messageEvent: (role, content, _body, extra = {}) => ({
    type: 'message',
    role,
    content,
    ...extra,
  }),
  contextOperationEvent: (payload) => ({
    type: 'context_operation',
    ...payload,
  }),
  buildSessionNavigationHref: (sessionId) => `https://chat.example/?session=${sessionId}&tab=sessions`,
  prepareFullParentContext: async () => ({
    mode: 'summary',
    summary: '父会话完整上下文。',
    continuationBody: '[User]\n父会话最近消息。',
    preparedThroughSeq: 12,
  }),
  setPreparedChildContext: async (childSessionId, prepared) => {
    preparedChildContexts.push({ childSessionId, prepared });
  },
  createDerivedRequestId: (destination, index) => `derived-${destination.mode}-${index + 1}`,
});

assert.equal(planningOutcome.applied, true, 'non-trivial plans should apply');
assert.equal(planningOutcome.submittedCurrent, true, 'mixed plan should still submit the current-session-owned slice');
assert.equal(planningOutcome.created.length, 1, 'mixed plan should create one child session for the fresh destination');
assert.equal(createdSessions.length, 1, 'only the fresh destination should create a child session here');
assert.equal(preparedChildContexts.length, 0, 'fresh child should not inherit full parent fork context');

assert.equal(submitted.length, 2, 'planner should submit both the current slice and the child session');
assert.equal(submitted[0].sessionId, 'session-source', 'first submission should stay in the current session');
assert.equal(submitted[0].options.recordedUserText, '把 planner schema 定下来。', 'current session should record only its scoped user slice');
assert.equal(submitted[1].sessionId, 'child-1', 'second submission should target the fresh child session');
assert.equal(submitted[1].options.requestId, 'derived-fresh-1', 'child session should receive a derived request id');
assert.match(submitted[1].text, /RemoteLab continuation planner handoff:/, 'child session prompt input should include a private planner handoff');
assert.equal(submitted[1].options.recordedUserText, '整理下周出差行程。', 'child session should record only its scoped user slice');

assert.equal(broadcastedSessionId, 'session-source', 'source session should be invalidated after appending the continuation notice');
const continuationNotice = appendedEvents.find((entry) => entry.event.type === 'message')?.event;
assert.ok(continuationNotice, 'continuation planning should append a visible notice to the source session');
assert.equal(continuationNotice.messageKind, 'session_continuation_notice', 'notice should use the new continuation message kind');
assert.match(continuationNotice.content || '', /\[下周出差行程\]\(https:\/\/chat\.example\/\?session=child-1&tab=sessions\)/, 'notice should keep a clickable child-session link');

const forkExecutionOutcome = await executeContinuationPlan({
  plan: forkPlan,
  sourceSession: {
    id: 'session-source',
    folder: '/tmp/workspace',
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
    thinking: false,
    group: 'Product',
    description: '梳理会话分流复用判定逻辑。',
    sourceId: 'chat',
    sourceName: 'Chat',
    templateId: '',
    templateName: '',
    systemPrompt: '',
    activeAgreements: [],
    userId: '',
    userName: '',
    latestSeq: 18,
    rootSessionId: 'session-root',
  },
  sourceSessionId: 'session-source',
  message: '把 UI 卡片那条线单独拉出来，别继续和 planner 架构讨论混在一起。',
  images: [],
  options: {
    requestId: 'req-fork',
    responseId: 'resp-fork',
    tool: 'fake-codex',
    model: 'fake-model',
    effort: 'low',
  },
  createSession: async (folder, tool, name, extra) => ({
    id: 'child-fork',
    folder,
    tool,
    name: name || '分流结果卡片 UI',
    ...extra,
  }),
  submitMessage: async (sessionId, text, images, options) => ({
    session: { id: sessionId, name: '分流结果卡片 UI' },
    run: { id: 'run-fork-child' },
  }),
  appendEvent: async () => ({}),
  broadcastInvalidation: () => {},
  messageEvent: (role, content, _body, extra = {}) => ({
    type: 'message',
    role,
    content,
    ...extra,
  }),
  contextOperationEvent: (payload) => ({
    type: 'context_operation',
    ...payload,
  }),
  buildSessionNavigationHref: () => '',
  prepareFullParentContext: async () => ({
    mode: 'summary',
    summary: '父会话完整上下文。',
    continuationBody: '[User]\n父会话最近消息。',
    preparedThroughSeq: 18,
  }),
  setPreparedChildContext: async (childSessionId, prepared) => {
    preparedChildContexts.push({ childSessionId, prepared });
  },
  createDerivedRequestId: () => 'derived-fork-1',
});

assert.equal(forkExecutionOutcome.created.length, 1, 'fork plan should create one child');
assert.ok(
  preparedChildContexts.some((entry) => entry.childSessionId === 'child-fork' && entry.prepared.summary === '父会话完整上下文。'),
  'fork children should receive the prepared full parent context',
);

if (previousDispatchSetting === undefined) delete process.env.REMOTELAB_SESSION_DISPATCH;
else process.env.REMOTELAB_SESSION_DISPATCH = previousDispatchSetting;

console.log('test-session-dispatch: ok');
