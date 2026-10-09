import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'remotelab-person-replies-'));
setIsolatedTestHome(home);
after(() => rm(home, { recursive: true, force: true }));
const { loadAuthDocument, updateAuthDocument } = await import('../lib/auth-config.mjs');
const { loadPersonMessageReplies, changePersonMessageReplies } = await import('../chat/person-message-replies.mjs');
const { resolveMessageReplyPolicy } = await import('../chat/message-reply-settings.mjs');
const { buildSessionDisplayEvents, buildEventBlockEvents } = await import('../chat/session-display-events.mjs');
const { collectFeishuInstanceWorkboardCycles, buildFeishuWorkboardCard } = await import('../connectors/feishu/workboard-pilot.mjs');
const { publishLiveAssistantReplies } = await import('../chat/native-final-publication.mjs');
const { handleMessageReplySettings } = await import('../chat/router-message-reply-settings.mjs');

await updateAuthDocument(document => {
  document.people = ['alice', 'bob'].map(name => ({ id: `person_${name}`, name, handle: name, credentials: [],
    preferences: { unrelated: name }, identities: ['web', 'feishu'].map(kind => ({ id: `${kind}_${name}`, kind,
      realm: kind === 'web' ? 'remotelab' : 'fixture', subjectId: name })) }));
  document.primaryPersonId = 'person_alice';
});
const actor = name => ({ personId: `person_${name}`, identityId: `web_${name}` });
const input = (surface, name = 'alice') => {
  const origin = { viewPersonId: `person_${name}`, initiatedByIdentityId: `${surface === 'web' ? 'web' : 'feishu'}_${name}` };
  if (surface === 'web') return { ...origin, usageSurface: 'web' };
  const chatType = surface === 'p2p' ? 'p2p' : 'group';
  const chatId = `oc_${surface}`, conversationKind = surface === 'thread' ? 'thread' : 'main';
  return { ...origin, feishuConnectorAuthenticated: true, sourceContext: { connector: 'feishu', sourceRouteId: 'fixture',
    chatType, chatId, messageId: 'om_human', sender: { openId: name, senderType: 'user' } },
  sourceDelivery: { connector: 'feishu', sourceRouteId: 'fixture', target: { chatType, chatId, conversationKind } } };
};
const allSurfaces = ['web', 'p2p', 'group', 'thread'];

test('saving is personal, durable, explicit and applies to all four human entry points', async () => {
  assert.equal((await loadPersonMessageReplies(actor('alice'))).active, null);
  for (const mode of ['messages', 'card_latest', 'card_all', 'none']) {
    const before = await loadPersonMessageReplies(actor('alice'));
    const choices = { opening: false, checklist: false, progress: mode };
    await assert.rejects(changePersonMessageReplies({ action: 'apply', expectedRevision: before.revision, choices }, actor('alice')), /明确/);
    const saved = await changePersonMessageReplies({ action: 'apply', expectedRevision: before.revision, confirm: true, choices }, actor('alice'));
    const snapshot = saved.active;
    assert.deepEqual((await loadPersonMessageReplies(actor('alice'))).active, snapshot);
    for (const surface of allSurfaces) {
      const policy = await resolveMessageReplyPolicy(input(surface));
      assert.deepEqual(policy, { ...snapshot, final: true }, surface);
      assert.equal(await resolveMessageReplyPolicy(input(surface, 'bob')), null, 'other members keep their defaults');
    }
    await assert.rejects(changePersonMessageReplies({ action: 'apply', expectedRevision: before.revision, confirm: true, choices }, actor('alice')), /已更新/);
    const file = JSON.parse(await readFile(join(home, '.config/remotelab/auth.json'), 'utf8'));
    assert.equal(file.people.find(p => p.id === 'person_alice').preferences.unrelated, 'alice');
    assert.equal(file.people.find(p => p.id === 'person_bob').preferences.messageReplies, undefined);
  }
  const alice = await loadPersonMessageReplies(actor('alice'));
  await changePersonMessageReplies({ action: 'apply', expectedRevision: 0, confirm: true,
    choices: { opening: true, checklist: true, progress: 'messages' } }, actor('bob'));
  assert.deepEqual(await loadPersonMessageReplies(actor('alice')), alice, 'another person saving cannot change your preference');
  await changePersonMessageReplies({ action: 'reset', expectedRevision: alice.revision, confirm: true }, actor('alice'));
  assert.equal(await resolveMessageReplyPolicy(input('web')), null);
  assert.equal((await resolveMessageReplyPolicy(input('web', 'bob'))).progress, 'messages');
});

test('only the verified sender and their own login can choose a personal mode', async () => {
  for (const identity of [{}, { ...actor('alice'), identityId: 'web_bob' }, { ...actor('alice'), authKind: 'service' }]) {
    await assert.rejects(loadPersonMessageReplies(identity), /本人/);
  }
  const revision = (await loadPersonMessageReplies(actor('alice'))).revision;
  await assert.rejects(changePersonMessageReplies({ action: 'apply', personId: 'person_bob', expectedRevision: revision,
    confirm: true, choices: { opening: true, checklist: true, progress: 'messages' } }, actor('alice')), /未知/);
  for (const options of [ { ...input('web', 'bob'), initiatedByIdentityId: 'web_alice' },
    { ...input('web', 'bob'), automationTitle: 'scheduled task' },
    { ...input('web', 'bob'), internalOperation: true },
    { ...input('thread', 'bob'), feishuConnectorAuthenticated: false },
    { ...input('thread', 'bob'), sourceContext: { ...input('thread', 'bob').sourceContext, sender: { openId: 'bob', senderType: 'bot' } } } ]) {
    assert.equal(await resolveMessageReplyPolicy(options), null);
  }
  let status;
  for (const method of ['GET', 'POST']) {
    await handleMessageReplySettings({ pathname: '/api/message-reply-settings', req: { method }, res: {},
      authSession: { ...actor('alice'), authKind: 'service' }, writeJson: (_res, code) => { status = code; } });
    assert.equal(status, 403);
  }
});

const historyFor = (mode, checklist = false, opening = false) => [
  { seq: 1, type: 'message', role: 'user', runId: 'run', content: 'review', messageReplyPolicy: {
    version: 3, scope: 'person', personId: 'person_alice', progress: mode, checklist, opening },
    sourceContext: input('thread').sourceContext, workboardAdmission: {
      personId: 'person_alice', identityId: 'feishu_alice', sourceRouteId: 'fixture', senderOpenId: 'alice' } },
  { seq: 2, type: 'message', role: 'assistant', runId: 'run', phase: 'commentary', content: '首条文字' },
  ...(checklist ? [{ seq: 3, type: 'message', role: 'assistant', runId: 'run', source: 'workboard_checklist',
    content: '目标：核对\n[ ] 第一项 — 核对来源。\n[ ] 第二项 — 交付结果。' }] : []),
  ...[4, 5].map(seq => ({ seq, type: 'message', role: 'assistant', runId: 'run', phase: 'commentary',
    content: `<progress>${seq === 4 ? '早期发现' : '最新发现'}</progress>` })),
  { seq: 6, type: 'message', role: 'assistant', runId: 'run', messageKind: 'user_question', content: '必要提问',
    questionState: 'pending', nativeQuestion: { questions: [] } },
  { seq: 7, type: 'message', role: 'assistant', runId: 'run', phase: 'final_answer', content: '最终答复' },
];

test('Web displays the chosen components, retains raw progress and always exposes questions and final', () => {
  for (const mode of ['messages', 'card_latest', 'card_all', 'none']) for (const checklist of [true, false]) for (const opening of [true, false]) {
    const raw = historyFor(mode, checklist, opening), before = JSON.stringify(raw);
    const visible = buildSessionDisplayEvents(raw, { exposeWorkboard: true, sessionRunning: false });
    assert.equal(visible.filter(e => e.surfaceKind === 'opening').length, Number(opening));
    assert.equal(visible.filter(e => e.surfaceKind === 'progress').length, mode === 'messages' ? 2 : 0);
    assert.equal(visible.filter(e => e.source === 'workboard_checklist').length, Number(checklist));
    assert.equal(visible.filter(e => e.messageKind === 'progress_panel').length, Number(!checklist && mode !== 'none'));
    assert(visible.some(e => e.content === '必要提问'));
    assert(visible.some(e => e.content === '最终答复'));
    assert.equal(JSON.stringify(raw), before, 'visibility never rewrites raw history');
    assert(buildEventBlockEvents(raw, 4, 5).some(e => e.content.includes('早期发现')));
  }
});

test('the same personal policy creates cards for private, main group and thread conversations', () => {
  for (const surface of ['p2p', 'group', 'thread']) for (const mode of ['messages', 'card_latest', 'card_all']) {
    const options = input(surface);
    const raw = historyFor(mode);
    raw[0].sourceContext = options.sourceContext;
    const session = { id: `s_${surface}`, workboardPilot: true, conversation: options.sourceDelivery };
    const cycles = collectFeishuInstanceWorkboardCycles(raw, { scope: 'instance', sourceRouteId: 'fixture',
      sessionId: session.id, chatId: options.sourceContext.chatId, cards: [], protocolAfterSeq: 0 }, session);
    assert.equal(cycles.length, 1, `${surface}/${mode}`);
    assert.equal(cycles[0].messageReplyPolicy.personId, 'person_alice');
    const card = JSON.stringify(buildFeishuWorkboardCard(cycles[0].content, cycles[0].board, cycles[0].progress, cycles[0]));
    assert.equal(card.includes('最新发现'), mode !== 'card_all');
    assert.equal(card.includes('展开全部进展'), mode === 'card_all');
  }
});

test('all Feishu destinations publish the selected text components with one durable final', async () => {
  for (const surface of ['p2p', 'group', 'thread']) for (const mode of ['messages', 'card_latest', 'card_all', 'none']) {
    const options = input(surface), events = historyFor(mode, false, true);
    const plan = { ...options.sourceDelivery, target: { ...options.sourceDelivery.target, messageId: 'om_human' } };
    let record = { key: surface + mode, runId: 'run', options: { messageReplyPolicy: events[0].messageReplyPolicy }, deliveries: [] };
    const store = { get: async () => record, mutate: async (_key, fn) => (record = fn(record)) };
    const session = { id: 'publication_' + surface, conversation: plan, workboardPilot: true };
    await publishLiveAssistantReplies(record, events.slice(0, -1), { store, plan, session, running: true });
    await publishLiveAssistantReplies(record, events, { store, plan, session, running: false });
    await publishLiveAssistantReplies(record, events, { store, plan, session, running: false });
    assert.equal(record.deliveries.filter(d => d.surfaceKind === 'opening').length, 1, surface);
    assert.equal(record.deliveries.filter(d => d.surfaceKind === 'progress').length, mode === 'messages' ? 2 : 0);
    assert.equal(record.deliveries.filter(d => d.surfaceKind === 'question').length, 1);
    assert.equal(record.deliveries.filter(d => d.surfaceKind === 'final').length, 1);
  }
});

test('usage observations follow personal saves and preserve version 3 card semantics', async () => {
  const { settingObserver } = await import('../chat/usage-settings.mjs');
  const rows = Object.values((await settingObserver.snapshot()).rows).filter(row => row.setting === 'reply.progress');
  assert.equal(rows.length, 2);
  assert(rows.every(row => row.scope === 'person'));
  assert(rows.some(row => row.value === 'messages'), 'version 3 messages includes a card, rather than legacy text-only progress');
  assert(rows.some(row => row.value === 'inherit'), 'restore defaults updates only that personal observation');
});
