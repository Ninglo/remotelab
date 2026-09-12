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
    else if (path === '/api/sessions') json = { sessions: [{ ...session, externalTriggerId: 'feishu:p2p:private' }] };
    else if (path === '/api/sessions/s1') {
      if (options.method === 'PATCH') {
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
    } else if (path === '/api/runtime-selection' && options.method === 'POST') {
      selection = {
        mode: 'default',
        tool: options.body.selectedTool,
        model: options.body.selectedModel,
        effort: options.body.selectedEffort,
        thinking: false,
      };
      json = { selection: {
        selectedTool: options.body.selectedTool,
        selectedModel: options.body.selectedModel,
        selectedEffort: options.body.selectedEffort,
        reasoningKind: options.body.reasoningKind,
      } };
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
  assert.deepEqual(extractLocalCommand({ ...summary, messageText: '@_user_1 /model beta' }), { type: 'model', text: 'beta' });
  assert.deepEqual(extractLocalCommand({ ...summary, chatType: 'p2p', messageText: '/status' }), { type: 'status', text: '' });
  assert.deepEqual(extractLocalCommand({ ...summary, chatType: 'p2p', messageText: '/default model beta' }), { type: 'default', text: 'model beta' });
  assert.equal(extractLocalCommand({ ...summary, messageText: 'example: /model beta' }), null);
  assert.equal(extractLocalCommand({ ...summary, messageText: '/modelled beta' }), null);
  const richFork = summarizeEvent({ message: {
    chat_type: 'group', message_type: 'post', content: JSON.stringify({ title: '', content: [
      [{ tag: 'at', user_id: '@_user_1', user_name: 'Task Bot' }, { tag: 'text', text: ' /fork discover datasets' }],
      [{ tag: 'text', text: 'keep the original table intact' }],
    ] }),
  } });
  assert.deepEqual(extractLocalCommand(richFork), {
    type: 'fork', text: '@Task Bot  discover datasets\nkeep the original table intact',
  }, 'a rich-text mention must not hide the fork marker');
  for (const [messageText, text] of [
    ['research first\n/fork then compare', 'research first\n then compare'],
    ['new task /FORK', 'new task'],
    ['请/fork调查', '请调查'],
    ['why does /fork fail?', 'why does  fail?'],
    ['/fork task /fork', 'task'],
    ['@_user_1 /fork', ''],
    ['/continue task /fork', '/continue task'],
  ]) {
    assert.deepEqual(extractLocalCommand({ ...summary, messageText }), { type: 'fork', text });
  }
  for (const chatType of ['p2p', 'private']) {
    assert.equal(extractLocalCommand({ ...summary, chatType, messageText: 'task /fork' }), null,
      'the fork marker keeps its group-only scope');
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
  const beforeInvalid = structuredClone(session);
  assert.match(await run('effort', 'ultra'), /不支持/);
  assert.match(await run('model', 'unknown'), /不可用/);
  assert.match(await run('harness', 'missing'), /不可用/);
  assert.deepEqual(session, beforeInvalid, 'invalid commands never mutate preferences');
  assert.match(await run('harness', 'pi'), /provider\/gamma/);
  assert.deepEqual(session.feishuRuntimeSelection, { tool: 'pi', model: 'provider/gamma', effort: '', thinking: false });
  assert.match(await run('effort', 'high'), /不支持/);
  assert.match(await run('follow'), /重置为 Default/);
  assert.equal(session.feishuRuntimeSelection?.tool, 'pi');
  assert.match(await run('status'), /provider\/gamma/);
  assert.match(await run('model', 'beta', { ...summary, threadId: 'unbound' }), /话题/);
  assert.match(await run('model', '', { ...summary, threadId: '' }), /provider\/gamma/);
  assert.match(await run('status', '', { ...summary, threadId: '', chatType: 'p2p', chatId: 'private' }), /当前 Session/);
  assert.match(await run('default', 'harness codex', { ...summary, threadId: 'unbound' }), /新 Session 的 Default/);
  assert.match(await run('default', 'model beta', { ...summary, threadId: 'unbound' }), /新 Session 的 Default/);
  assert.equal(selection.model, 'beta', 'Default command should update the shared default selection');
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
  assert.match(replies.at(-1), /\/follow/);
  runtime.botIdentity = { openId: 'this-bot' };
  const botControl = await handleMessage(runtime, { ...summary, messageText: '/model provider/gamma',
    mentions: [{ openId: 'this-bot' }], sender: { senderType: 'app' } }, 'test', helpers);
  assert.equal(botControl.reason, 'bot_control_command');
  assert.equal(session.feishuRuntimeSelection?.tool, 'pi', 'peer bots cannot change runtime preferences');
  assert.equal(aiCalls, 0, 'control commands never run through a model');

  // Persist the exact command plan before PATCH, then reuse it on inbox retry.
  selection = { mode: 'ui', tool: 'codex', model: 'alpha', effort: 'low', thinking: false };
  let plan;
  await run('model', 'beta', summary, { savePlan: async value => { plan = structuredClone(value); } });
  const pinned = structuredClone(session.feishuRuntimeSelection);
  selection = { mode: 'ui', tool: 'pi', model: 'provider/gamma', effort: '', thinking: false };
  const replay = await run('model', 'beta', summary, { prepared: plan });
  assert.match(replay, /beta/);
  assert.deepEqual(session.feishuRuntimeSelection, pinned, 'retry keeps the accepted command selection');
  session.feishuRuntimeSelection = { tool: 'pi', model: 'provider/gamma', effort: '', thinking: false };
  brokenCatalog = 'pi';
  assert.match(await run('harness'), /\/harness codex/, 'listing Harnesses works even if the current provider fails');
  assert.match(await run('harness', 'codex'), /codex/, 'switching away does not need the old provider catalog');
  console.log('test-feishu-runtime-commands: ok');
} finally {
  await rm(home, { recursive: true, force: true });
}
