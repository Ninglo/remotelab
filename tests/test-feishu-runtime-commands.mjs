import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'remotelab-feishu-commands-'));
setIsolatedTestHome(home);
try {
  const { handleMessage, extractLocalCommand, recordFeishuThreadSessionBinding, summarizeEvent } = await import('../scripts/feishu-connector.mjs');
  const { handleFeishuRuntimeCommand } = await import('../connectors/feishu/runtime-commands.mjs');
  const session = { id: 's1', tool: 'codex', model: 'alpha', effort: 'low' };
  const catalog = {
    codex: { defaultModel: 'alpha', models: [
      { id: 'alpha', reasoning: { kind: 'enum', levels: ['low', 'high'], default: 'low' } },
      { id: 'beta', reasoning: { kind: 'enum', levels: ['medium', 'high'], default: 'medium' } },
    ] },
    pi: { defaultModel: 'provider/gamma', models: [{ id: 'provider/gamma', reasoning: { kind: 'none' } }] },
  };
  const calls = [];
  let brokenCatalog = '';
  const request = async (path, options = {}) => {
    calls.push({ path, ...options });
    let json;
    if (path === '/api/tools') json = { tools: [{ id: 'codex', available: true }, { id: 'pi', available: true }, { id: 'missing', available: false }] };
    else if (path.startsWith('/api/models?tool=')) {
      const tool = decodeURIComponent(path.split('=')[1]);
      if (tool === brokenCatalog) throw new Error('Current provider is unavailable');
      json = catalog[tool];
    }
    else if (path === '/api/runtime-presets') json = { presets: [
      { id: 'sota', model: 'frontier', effort: 'xhigh' },
      { id: 'quality', model: 'alpha', effort: 'high' },
      { id: 'balanced', model: 'beta', effort: 'medium' },
      { id: 'economy', model: 'cheap', effort: 'low' },
    ] };
    else if (path === '/api/session-conversations/resolve') json = { sessionId: options.body?.conversation?.target?.conversationKind === 'main' ? 's1' : null };
    else if (path === '/api/sessions') json = { sessions: [{ ...session, externalTriggerId: 'feishu:p2p:private' }] };
    else if (path === '/api/sessions/s1') {
      if (options.method === 'PATCH') {
        if (Object.prototype.hasOwnProperty.call(options.body, 'runtimeTier')) {
          const preset = {
            sota: { model: 'frontier', effort: 'xhigh' },
            quality: { model: 'alpha', effort: 'high' },
            balanced: { model: 'beta', effort: 'medium' },
            economy: { model: 'cheap', effort: 'low' },
          }[options.body.runtimeTier];
          session.tool = 'codex';
          session.model = preset.model;
          session.effort = preset.effort;
          session.runtimeTier = options.body.runtimeTier;
        }
        if (Object.prototype.hasOwnProperty.call(options.body, 'tool')) session.tool = options.body.tool;
        if (Object.prototype.hasOwnProperty.call(options.body, 'model')) session.model = options.body.model;
        if (Object.prototype.hasOwnProperty.call(options.body, 'effort')) session.effort = options.body.effort;
        if (Object.prototype.hasOwnProperty.call(options.body, 'thinking')) session.thinking = options.body.thinking;
        session.feishuRuntimeSelection = {
          tool: session.tool,
          model: session.model,
          effort: session.effort,
          thinking: session.thinking === true,
        };
      }
      json = { session: structuredClone(session) };
    } else throw new Error(`Unexpected request ${path}`);
    return { response: { ok: true, status: 200 }, json };
  };
  let selection = { mode: 'ui', tool: 'codex', model: 'alpha', effort: 'low', thinking: false };
  const runtime = { config: { sourceRouteId: 'bot-2', responsePolicy: { group: 'all' } },
    storagePaths: { messageIndexPath: join(home, 'index.json') } };
  const summary = { chatId: 'chat', chatType: 'group', threadId: 'thread', tenantKey: 'tenant',
    messageId: 'm1', messageType: 'text', sender: { senderType: 'user' } };
  await recordFeishuThreadSessionBinding(runtime, summary, session.id);
  const options = { request, resolveDefault: async () => ({ ...selection }) };
  const run = (type, text = '', target = summary, extra = {}) => handleFeishuRuntimeCommand(runtime, target, { type, text }, { ...options, ...extra });
  assert.deepEqual(extractLocalCommand({ ...summary, messageText: '@_user_1 /model beta' }), { commands: [{ name: 'model', value: 'beta' }], body: '' });
  assert.deepEqual(extractLocalCommand({ ...summary, messageText: '@_user_1 /m beta' }), { commands: [{ name: 'model', value: 'beta' }], body: '' });
  assert.deepEqual(extractLocalCommand({ ...summary, messageText: '@_user_1 /tier sota' }), { commands: [{ name: 'tier', value: 'sota' }], body: '' });
  assert.deepEqual(extractLocalCommand({ ...summary, chatType: 'p2p', messageText: '/status' }), { commands: [{ name: 'status' }], body: '' });
  assert.match(extractLocalCommand({ ...summary, chatType: 'p2p', messageText: '/default model beta' }).error, /固定为 Auto/);
  assert.equal(extractLocalCommand({ ...summary,
    messageText: 'connector 命令易用性可能设计下，比如消息里带上很多命令（包括 /thread 之类）。',
  }), null, 'mentioning /thread in prose must not create a new task Session');
  assert.equal(extractLocalCommand({ ...summary, messageText: 'example: /model beta' }), null);
  for (const messageText of [
    '@_user_1 /mnt/train/public 的旧数据对象已全部删除',
    '/root/workspace/MUKA-FoundationModel 已经 git clone 了 git 仓库，看看能不能访问',
    '/modelled beta',
  ]) {
    assert.equal(extractLocalCommand({ ...summary, messageText }), null,
      'unregistered slash-prefixed text must not enter command handling');
  }
  const richThread = { ...summary, messageText: '@Task Bot /thread\n\nkeep the original table intact' };
  assert.deepEqual(extractLocalCommand(richThread), {
    commands: [{ name: 'thread' }], body: 'keep the original table intact',
  }, 'a rich-text mention must not hide the thread marker');
  for (const [messageText, body] of [
    ['/thread\n\nthen compare', 'then compare'],
    ['/thread then compare', 'then compare'],
    ['/thread\nthen compare', 'then compare'],
    ['/thread', ''],
    ['@_user_1 /thread', ''],
  ]) {
    assert.deepEqual(extractLocalCommand({ ...summary, messageText }), { commands: [{ name: 'thread' }], body });
  }
  assert.deepEqual(extractLocalCommand({ ...summary, messageText: '/quick\n\n直接回答' }), {
    commands: [{ name: 'quick' }], body: '直接回答',
  });
  for (const messageText of ['new task /THREAD', '请/thread调查', 'why does /thread fail?', '/inline\n\n/thread']) {
    assert.notEqual(extractLocalCommand({ ...summary, messageText })?.commands?.some(command => command.name === 'thread'), true,
      'thread must not be inferred from a prose or nested command mention');
  }
  for (const chatType of ['p2p', 'private']) {
    assert.deepEqual(extractLocalCommand({ ...summary, chatType, messageText: '/thread\n\ntask' }),
      { commands: [{ name: 'thread' }], body: 'task' }, 'private and group mainlines share the reply-mode commands');
  }
  assert.match(await run('status'), /作用范围：当前 Session/);
  assert.match(await run('model'), /\/model beta/);
  assert.equal(session.feishuRuntimeSelection, undefined, 'listing must not mutate the Session');
  assert.match(await run('model', 'beta'), /beta/);
  assert.deepEqual(session.feishuRuntimeSelection, { tool: 'codex', model: 'beta', effort: 'medium', thinking: false });
  selection = { mode: 'ui', tool: 'pi', model: 'provider/gamma', effort: '', thinking: false };
  assert.match(await run('status'), /beta/);
  assert.match(await run('effort', 'high'), /high/);
  assert.equal(session.feishuRuntimeSelection.effort, 'high');
  assert.match(await run('tier'), /\/tier sota/);
  assert.match(await run('tier', 'sota'), /frontier/);
  assert.equal(session.runtimeTier, 'sota');
  assert.equal(session.model, 'frontier');
  assert.equal(session.effort, 'xhigh');
  assert.match(await run('tier', 'auto'), /未知档位/);
  const beforeInvalid = structuredClone(session);
  assert.match(await run('effort', 'ultra'), /不支持/);
  assert.match(await run('model', 'unknown'), /不可用/);
  assert.match(await run('harness', 'missing'), /不可用/);
  assert.deepEqual(session, beforeInvalid, 'invalid commands never mutate preferences');
  assert.match(await run('harness', 'pi'), /provider\/gamma/);
  assert.deepEqual(session.feishuRuntimeSelection, { tool: 'pi', model: 'provider/gamma', effort: '', thinking: false });
  assert.match(await run('effort', 'high'), /不支持/);
  assert.match(await run('status'), /provider\/gamma/);
  assert.match(await run('model', 'beta', { ...summary, threadId: 'unbound' }), /话题/);
  assert.match(await run('model', '', { ...summary, threadId: '' }), /provider\/gamma/);
  assert.match(await run('status', '', { ...summary, threadId: '', chatType: 'p2p', chatId: 'private' }), /当前 Session/);
  assert.equal(calls.some(call => call.path === '/api/sessions' && call.method === 'POST'), false, 'commands never create AI sessions');

  const replies = [];
  let aiCalls = 0;
  const helpers = {
    requestRemoteLab: request,
    resolveFeishuRuntimeSelection: async () => ({ ...selection }),
    queueFeishuReply: async (_runtime, _summary, text) => replies.push(text),
    addProcessingReaction: async () => { throw new Error('commands must not start processing reactions'); },
    submitRemoteLabRequest: async () => { aiCalls++; return { sessionId: 'unexpected' }; },
  };
  await handleMessage(runtime, { ...summary, messageText: '/status' }, 'test', helpers);
  assert.match(replies.at(-1), /当前 Session/);
  await handleMessage(runtime, { ...summary, messageId: 'm2', messageText: '/help' }, 'test', helpers);
  assert.doesNotMatch(replies.at(-1), /\/follow|\/default/);
  assert.match(replies.at(-1), /\/tier/);
  assert.match(replies.at(-1), /短名：\/m model、\/q quick/);
  runtime.botIdentity = { openId: 'this-bot' };
  const botControl = await handleMessage(runtime, { ...summary, messageText: '/model provider/gamma',
    mentions: [{ openId: 'this-bot' }], sender: { senderType: 'app' } }, 'test', helpers);
  assert.equal(botControl.reason, 'bot_control_command');
  assert.equal(session.feishuRuntimeSelection?.tool, 'pi', 'peer bots cannot change runtime preferences');
  assert.equal(aiCalls, 0, 'control commands never run through a model');

  let quickSummary;
  await handleMessage(runtime, { ...summary, threadId: '', rootId: '', messageId: 'quick-task', messageText: '/q 只回答结论。' }, 'test', {
    addProcessingReaction: async () => null,
    submitRemoteLabRequest: async (_runtime, inboundSummary) => {
      quickSummary = inboundSummary;
      return { sessionId: 'quick-session', runId: 'run-quick' };
    },
  });
  assert.equal(quickSummary.quickMode, true);
  assert.equal(quickSummary.startThread, true);
  assert.equal(quickSummary.conversationKind, 'thread');
  assert.equal(quickSummary.messageText, '只回答结论。');

  let commandBlockSummary;
  let commandBlockPlan;
  await handleMessage(runtime, { ...summary, threadId: '', rootId: '', messageId: 'command-block-task', messageText: '/thread --harness pi --model provider/gamma 请执行这个任务。' }, 'test', {
    requestRemoteLab: request,
    resolveFeishuRuntimeSelection: async () => ({ mode: 'ui', tool: 'codex', model: 'alpha', effort: 'low', thinking: false }),
    addProcessingReaction: async () => null,
    saveRuntimeCommand: async value => { commandBlockPlan = structuredClone(value); },
    submitRemoteLabRequest: async (_runtime, inboundSummary) => {
      commandBlockSummary = inboundSummary;
      return { sessionId: 'new-task', runId: 'run-command-block' };
    },
  });
  assert.equal(commandBlockSummary.startThread, true);
  assert.equal(commandBlockSummary.conversationKind, 'thread');
  assert.equal(commandBlockSummary.messageText, '请执行这个任务。');
  assert.deepEqual(commandBlockSummary.runtimeSelectionOverride, {
    tool: 'pi', model: 'provider/gamma', effort: '', thinking: false,
  });
  assert.deepEqual(commandBlockPlan.selection, commandBlockSummary.runtimeSelectionOverride);

  // Persist the exact command plan before PATCH, then reuse it on inbox retry.
  selection = { mode: 'ui', tool: 'codex', model: 'alpha', effort: 'low', thinking: false };
  let plan;
  await run('model', 'beta', summary, { savePlan: async value => { plan = structuredClone(value); } });
  const pinned = structuredClone(session.feishuRuntimeSelection);
  selection = { mode: 'ui', tool: 'pi', model: 'provider/gamma', effort: '', thinking: false };
  const replay = await run('model', 'beta', summary, { prepared: plan });
  assert.match(replay, /beta/);
  assert.deepEqual(session.feishuRuntimeSelection, pinned, 'retry keeps the accepted command selection');
  session.executionProfile = 'quick';
  assert.match(await run('status'), /模式：Quick/);
  const patchCallsBeforeQuickMutation = calls.filter(call => call.path === '/api/sessions/s1' && call.method === 'PATCH').length;
  assert.match(await run('model', 'beta'), /创建时固定/);
  assert.equal(calls.filter(call => call.path === '/api/sessions/s1' && call.method === 'PATCH').length, patchCallsBeforeQuickMutation,
    'Quick Session runtime commands must not reach PATCH');
  delete session.executionProfile;
  session.feishuRuntimeSelection = { tool: 'pi', model: 'provider/gamma', effort: '', thinking: false };
  brokenCatalog = 'pi';
  assert.match(await run('harness'), /\/harness codex/, 'listing Harnesses works even if the current provider fails');
  assert.match(await run('harness', 'codex'), /codex/, 'switching away does not need the old provider catalog');
  console.log('test-feishu-runtime-commands: ok');
} finally {
  await rm(home, { recursive: true, force: true });
}
