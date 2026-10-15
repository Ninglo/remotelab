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
  assert.match(JSON.stringify(lastCard()), /打开主会话/);
  assert.ok(!lastCard().body.elements.some(x => x.tag === 'form'), 'new groups get compact cards without a layout flag');
  let actionCount = 0;
  const action = async (operation, fields, revision = null, extra = {}) => {
    const result = await controller.action({ header: { event_id: extra.eventId || `action-${++actionCount}` }, event: {
      context: { open_chat_id: source.chatId, open_message_id: record.cardMessageId },
      operator: { open_id: extra.actor || 'human' }, action: { value: {
        namespace: 'group-configuration', key: record.key, revision: revision || (await controller.view(record)).revision,
        action: operation, chunks: 1 }, form_value: fields },
    } });
    await controller.idle();
    return result;
  };
  const { GROUP_ROUTING_PILOT_FILE, routingPilotScope } = await import('../lib/group-routing-pilot.mjs');
  const { updateAuthDocument } = await import('../lib/auth-config.mjs');
  const { loadPersonMessageReplies } = await import('../chat/person-message-replies.mjs');
  const { captureMessageRoutingOptions } = await import('../chat/message-routing-policy.mjs');
  await updateAuthDocument(doc => {
    doc.people = ['human', 'other'].map(name => ({ id: `person_${name}`, name, credentials: [],
      identities: [{ id: `identity_${name}`, kind: 'feishu', realm: config.sourceRouteId, subjectId: name }] }));
    doc.primaryPersonId = 'person_human';
  });
  const pilot = { version: 2, enabled: true, personalOptIn: true, trialId: 'test', scopeLabel: '六个测试群',
    groups: [{ sourceRouteId: config.sourceRouteId, tenantKey: source.tenantKey, chatId: source.chatId, folder: home }] };
  await writeFile(GROUP_ROUTING_PILOT_FILE, JSON.stringify(pilot));
  const conversation = { connector: 'feishu', sourceRouteId: config.sourceRouteId, target: source };
  const actor = name => ({ personId: `person_${name}`, identityId: `identity_${name}` });
  const admission = name => captureMessageRoutingOptions({ conversation }, {
    viewPersonId: `person_${name}`, initiatedByIdentityId: `identity_${name}`, feishuConnectorAuthenticated: true,
    sourceContext: { ...source, connector: 'feishu', sourceRouteId: config.sourceRouteId, messageId: 'input', sender: { openId: name, senderType: 'user' } },
    sourceDelivery: conversation,
  });
  assert.equal((await admission('human')).messageRoutingPolicy.mechanism, 'none');
  assert.equal((await action('routing-on', {}, null, { eventId: 'enable-once' })).toast.type, 'success');
  assert.equal((await admission('human')).messageRoutingPolicy.trialId, 'test');
  assert.equal((await admission('other')).messageRoutingPolicy.mechanism, 'none');
  assert.equal((await loadPersonMessageReplies(actor('other'))).revision, 0);
  const rev = (await loadPersonMessageReplies(actor('human'))).revision;
  await action('routing-on');
  assert.equal((await loadPersonMessageReplies(actor('human'))).revision, rev, 'repeated enable is idempotent');
  assert.match((await action('routing-status')).toast.content, /已开启/);
  assert.equal((await action('routing-on', {}, null, { actor: 'outsider' })).toast.type, 'error');
  await action('routing-off');
  assert.equal((await admission('human')).messageRoutingPolicy.mechanism, 'none');
  await action('routing-on', {}, null, { eventId: 'enable-once' });
  assert.equal((await admission('human')).messageRoutingPolicy.mechanism, 'none', 'late callback replay does not undo subsequent disable');
  const { buildGroupConfigurationCard } = await import('../connectors/feishu/group-configuration-card.mjs');
  for (const cardLayout of [undefined, 'compact', 'full']) {
    const migrated = buildGroupConfigurationCard({ ...record, cardLayout }, await controller.view(record));
    assert.doesNotMatch(JSON.stringify(migrated), /刷新当前配置|修改主讨论模型|编辑本群 prompt/);
  }
  const workCard = buildGroupConfigurationCard(record, { ...await controller.view(record), project: null,
    participationControls: false, responseMode: 'all' });
  assert.match(JSON.stringify(workCard), /本群逐条回应/);
  assert.equal(workCard.header.title.content, 'Agent · 话题内逐条回应');
  const originalMessageId = record.cardMessageId;
  await runtime.participation.remember(source, session.id);
  assert.equal((await runtime.participation.state(source)).cardMessageId, originalMessageId,
    'refreshing an existing group keeps its card message');
  const trialCard = JSON.stringify((await import('../connectors/feishu/group-configuration-card.mjs')).buildGroupConfigurationCard(
    { ...record, cardLayout: 'compact' }, await controller.view(record)));
  assert.match(trialCard, /为我开启/);
  assert.match(trialCard, /不自动新建飞书话题/);
  assert.equal(await routingPilotScope({ ...conversation, target: { ...source, chatId: 'outside' } }, undefined, 'person_human'), null);
  await writeFile(GROUP_ROUTING_PILOT_FILE, JSON.stringify({ ...pilot, personalOptIn: false, personIds: ['person_other'] }));
  assert.equal(await routingPilotScope(conversation, undefined, 'person_human'), null, 'old allowlist remains closed');
  assert.equal((await action('routing-on')).toast.type, 'error', 'withdrawn pilot rejects stale buttons');
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
  assert.match((await controller.view(record)).systemPrompt, /本群讨论机器人实验/);
  assert.doesNotMatch(JSON.stringify(lastCard()), /本群讨论机器人实验/, 'saved prompts stay out of compact cards');
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
  let resolvedOnly = 0;
  await onboardFeishuGroup(runtime, { ...source, chatId: 'work' }, { projectCard: true,
    requestRemoteLab: async (path) => {
      assert.equal(path, '/api/session-conversations/resolve'); resolvedOnly++;
      return { response: { ok: true }, json: { sessionId: session.id } };
    } });
  assert.equal(resolvedOnly, 1, 'project card reuses an existing main Session without creating or starting work');
  assert.equal(config.groups.work.responseMode, 'all', 'project card does not change work-group response policy');
  const count = onboardRequests.length;
  await onboardFeishuGroup(runtime, { ...joined, chatId: 'private' }, onboardOptions);
  assert.equal(onboardRequests.length, count, 'rejoining does not erase an explicit mention-only group policy');
  console.log('Feishu group configuration: defaults, scope, callbacks, stale edits, runtime readback and durable prompt passed');
} finally { await rm(home, { recursive: true, force: true }); }
