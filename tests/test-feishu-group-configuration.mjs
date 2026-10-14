import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'feishu-group-configuration-'));
setIsolatedTestHome(home);
process.env.REMOTELAB_PUBLIC_BASE_URL = 'https://remotelab.test';
try {
  const { createParticipationController, participationEnabled } = await import('../connectors/feishu/participation-state.mjs');
  const { createGroupConfigurationController } = await import('../connectors/feishu/group-configuration.mjs');
  const { resolveFeishuGroupSettings } = await import('../connectors/feishu/group-settings.mjs');
  const { loadConfig, onboardFeishuGroup } = await import('../scripts/feishu-connector.mjs');
  const configPath = join(home, 'config.json');
  await writeFile(configPath, JSON.stringify({ appId: 'test', appSecret: 'test', storageDir: home }));
  const config = await loadConfig(configPath);
  assert.equal(config.defaultGroupParticipation, 'active');
  const source = { chatId: 'group', tenantKey: 'tenant', chatType: 'group', chatMode: 'group', conversationKind: 'main' };
  assert.equal(resolveFeishuGroupSettings(config, source).responseMode, 'all');
  assert.equal(participationEnabled({ config }, source), true);
  assert.equal(participationEnabled({ config }, { ...source, chatType: 'p2p' }), false);
  config.groups = { private: { responseMode: 'mention_only' }, work: { responseMode: 'all' }, hidden: {
    participationMode: 'ambient', participationControls: true, participationStatusCard: false } };
  assert.equal(resolveFeishuGroupSettings(config, { ...source, chatId: 'private' }).responseMode, 'mention_only');
  assert.equal(participationEnabled({ config }, { ...source, chatId: 'work' }), false, 'existing work groups retain their policy');

  let session = { id: 'a'.repeat(32), tool: 'codex', model: 'alpha', effort: 'low' };
  const catalog = { defaultModel: 'alpha', models: [
    { id: 'alpha', reasoning: { kind: 'enum', levels: ['low', 'high'], default: 'low' } },
    { id: 'beta', reasoning: { kind: 'enum', levels: ['medium', 'high'], default: 'medium' } },
  ] };
  const cards = [], patches = [];
  const runtime = { config, storagePaths: {}, botIdentity: { openId: 'bot' }, appClient: { im: { v1: {
    message: { create: async payload => { cards.push(JSON.parse(payload.data.content)); return { code: 0, data: { message_id: 'om_card' } }; },
      patch: async payload => { cards.push(JSON.parse(payload.data.content)); return { code: 0 }; } },
    chatTopNotice: { putTopNotice: async () => ({ code: 0 }) },
  } } } };
  const request = async (path, options = {}) => {
    let json;
    if (path === '/api/session-conversations/resolve') json = { sessionId: session.id };
    else if (path === `/api/sessions/${session.id}`) {
      if (options.method === 'PATCH') { patches.push(options.body); session = { ...session,
        feishuRuntimeSelection: { ...options.body } }; }
      json = { session };
    } else if (path.startsWith('/api/models?')) json = catalog;
    else throw new Error(`unexpected request: ${path}`);
    return { response: { ok: true, status: 200 }, json };
  };
  let controller;
  runtime.participation = createParticipationController(runtime, { authorize: async () => true, cancelSession: async () => {},
    getConfiguration: record => controller.view(record) });
  const options = { request, resolveDefault: async () => session, participation: () => runtime.participation,
    authorize: async summary => summary.sender.openId === 'human' };
  controller = createGroupConfigurationController(runtime, options);
  await runtime.participation.remember(source, session.id);
  const record = await runtime.participation.state(source);
  const lastCard = () => cards.at(-1);
  assert.equal(lastCard().schema, '2.0');
  assert.match(JSON.stringify(lastCard()), /alpha/);
  assert.match(JSON.stringify(lastCard()), /查看主讨论记录/);
  assert.ok(lastCard().body.elements.some(x => x.tag === 'form'));
  const action = async (operation, fields, revision = null, extra = {}) => {
    const result = await controller.action({ header: { event_id: `action-${cards.length}` }, event: {
      context: { open_chat_id: source.chatId, open_message_id: record.cardMessageId },
      operator: { open_id: extra.actor || 'human' }, action: { value: {
        namespace: 'group-configuration', key: record.key, revision: revision || (await controller.view(record)).revision,
        action: operation, chunks: 1 }, form_value: fields },
    } });
    await controller.idle();
    return result;
  };
  const stale = (await controller.view(record)).revision;
  await action('model', { model: 'beta' });
  assert.equal(session.feishuRuntimeSelection.model, 'beta');
  assert.equal(session.feishuRuntimeSelection.effort, 'medium', 'model change selects the new model default');
  await action('effort', { effort: 'high' });
  assert.equal(session.feishuRuntimeSelection.effort, 'high');
  const before = patches.length;
  await action('model', { model: 'alpha' }, stale);
  assert.equal(patches.length, before, 'stale card cannot overwrite a newer runtime choice');
  assert.equal((await action('model', { model: 'alpha' }, null, { actor: 'outsider' })).toast.type, 'error');
  await action('prompt', { prompt_0: '本群讨论机器人实验；结论需要有证据。' });
  assert.match(resolveFeishuGroupSettings(config, source).systemPrompt, /本群讨论机器人实验/);
  assert.match(JSON.stringify(lastCard()), /本群讨论机器人实验/);
  assert.equal((await controller.view(record)).promptVersion, 1);
  controller = createGroupConfigurationController(runtime, options);
  config.groups.group.systemPrompt = 'wrong';
  await controller.restore();
  assert.match(config.groups.group.systemPrompt, /本群讨论机器人实验/, 'prompt survives restart and is the intake source');
  await action('prompt', { prompt_0: '' });
  assert.equal(config.groups.group.systemPrompt, '', 'an explicit empty prompt clears the override');
  const writes = cards.length;
  await runtime.participation.remember({ ...source, chatId: 'hidden' }, session.id);
  assert.equal(cards.length, writes, 'hidden status cards are not recreated');
  const onboardRequests = [];
  const onboardOptions = { enrichSummaryWithChatMetadata: async (_runtime, summary) => summary,
    resolveFeishuRuntimeSelection: async () => session,
    requestRemoteLab: async (path, options) => {
      onboardRequests.push({ path, body: options.body });
      assert.equal(path, '/api/sessions', 'joining a group creates a Session without submitting a fake user input');
      return { response: { ok: true }, json: { session } };
    } };
  const joined = { ...source, chatId: 'joined', messageId: 'bot-added:real-event', sourceKind: 'bot_added' };
  await onboardFeishuGroup(runtime, joined, onboardOptions);
  await onboardFeishuGroup(runtime, joined, onboardOptions);
  assert.equal((await runtime.participation.state(joined)).mode, 'active');
  assert.match(onboardRequests[0].body.externalTriggerId, /feishu:group-feed:/);
  assert.equal(onboardRequests[0].body.externalTriggerId, onboardRequests[1].body.externalTriggerId,
    'event retry uses the same idempotent main Session identity');
  assert.equal((await runtime.participation.state(joined)).sessionId, session.id);
  await runtime.participation.change(joined, 'paused', { controlId: 'keep-pause' });
  await onboardFeishuGroup(runtime, joined, onboardOptions);
  assert.equal((await runtime.participation.state(joined)).mode, 'paused', 'rejoining must preserve an explicit pause');
  const count = onboardRequests.length;
  await onboardFeishuGroup(runtime, { ...joined, chatId: 'private' }, onboardOptions);
  assert.equal(onboardRequests.length, count, 'rejoining does not erase an explicit mention-only group policy');
  console.log('Feishu group configuration: defaults, scope, callbacks, stale edits, runtime readback and durable prompt passed');
} finally { await rm(home, { recursive: true, force: true }); }
