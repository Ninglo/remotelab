import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const home = await mkdtemp(join(tmpdir(), 'feishu-engagement-'));
setIsolatedTestHome(home);
after(() => rm(home, { recursive: true, force: true }));
const { createUsageEventStore, normalizeUsageEvent } = await import('../chat/usage-events.mjs');
const { recordFeishuCardAction, recordFeishuCardReads, handleFeishuCardReadEvent, createFeishuCardReadSampler }
  = await import('../connectors/feishu/card-engagement.mjs');
const { readFeishuCardSamplingCoverage } = await import('../lib/feishu-card-engagement.mjs');
const resolvePerson = async (route, actor) => route === 'bot-a' && actor === 'reader' ? 'verified-person' : '';
const card = { sessionId: 'session', messageId: 'card-message', anchorSeq: 2, chatId: 'group', createdAt: Date.now() };
const readers = [{ user_id: 'reader', user_id_type: 'open_id', timestamp: String(Date.now() - 1000) }];

test('clicks, delivery choices and first-read signals are private, route scoped and deduplicated across restart', async () => {
  const directory = join(home, 'ledger');
  const store = createUsageEventStore({ directory, loadSessionOrigins: async () => ({ origins: [], errors: 0 }) });
  const click = { route: 'bot-a', actor: 'reader', messageId: card.messageId, sessionId: card.sessionId,
    value: { namespace: 'progress-card', mode: 'expanded', anchorSeq: 2 }, changeId: 'event-1', accepted: true };
  await recordFeishuCardAction(click, { store, resolvePerson });
  await recordFeishuCardAction(click, { store, resolvePerson });
  await recordFeishuCardAction({ ...click, changeId: 'event-2', value: { ...click.value, mode: 'collapsed' } }, { store, resolvePerson });
  await recordFeishuCardAction({ ...click, changeId: 'event-3', value: { namespace: 'session-progress', mode: 'card' } }, { store, resolvePerson });
  await recordFeishuCardAction({ ...click, changeId: 'failed', accepted: false }, { store, resolvePerson });
  await recordFeishuCardReads('bot-a', card, readers, { store, resolvePerson });
  const restarted = createUsageEventStore({ directory, loadSessionOrigins: async () => ({ origins: [], errors: 0 }) });
  await recordFeishuCardAction(click, { store: restarted, resolvePerson });
  await recordFeishuCardReads('bot-a', card, readers, { store: restarted, resolvePerson });
  await recordFeishuCardAction({ ...click, route: 'bot-b' }, { store: restarted, resolvePerson });
  const summary = await restarted.query();
  assert.equal(summary.total, 6);
  assert.equal(summary.feishuCards.byUser.length, 2, 'equal open_ids in different apps are never silently merged');
  assert.equal(summary.feishuCards.totals.expandClicks, 2);
  assert.equal(summary.feishuCards.totals.collapseClicks, 1);
  assert.equal(summary.feishuCards.totals.deliveryChoices.card, 1);
  assert.equal(summary.feishuCards.totals.rejectedClicks, 1);
  assert.equal(summary.feishuCards.totals.readCards, 1);
  const log = (await readdir(directory)).find(name => name.endsWith('.jsonl'));
  const raw = await readFile(join(directory, log), 'utf8');
  assert.doesNotMatch(raw, /reader|verified-person|card-message/);
  assert.equal(normalizeUsageEvent({ event: 'feishu_card_action', eventId: 'forged' }, { client: true }), null);
  assert.equal(await recordFeishuCardAction(click, { resolvePerson: async () => { throw Error('broken identity'); } }), false);
});

async function stateFixture(name) {
  const stateDir = join(home, name), statePath = join(home, 'sampling', `${name}.json`);
  await mkdir(stateDir);
  await writeFile(join(stateDir, 'a.json'), JSON.stringify({ sourceRouteId: 'bot-a', sessions: {
    [card.sessionId]: { chatId: card.chatId, cards: [card] } } }));
  await writeFile(join(stateDir, 'other.json'), JSON.stringify({ sourceRouteId: 'bot-b', sessions: {
    hidden: { chatId: 'other-chat', cards: [{ ...card, messageId: 'other-card' }] } } }));
  return { stateDir, statePath };
}

test('passive events accept only tracked card receipts and match the API first-read key', async () => {
  const { stateDir } = await stateFixture('passive');
  const store = createUsageEventStore({ directory: join(home, 'passive-ledger') });
  const runtime = { config: { sourceRouteId: 'bot-a' } };
  const event = { reader: { reader_id: { open_id: 'reader' }, read_time: readers[0].timestamp },
    message_id_list: ['card-message', 'other-card', 'untracked-message'] };
  await handleFeishuCardReadEvent(runtime, { event }, { stateDir, store, resolvePerson });
  await recordFeishuCardReads('bot-a', card, readers, { store, resolvePerson });
  assert.equal((await store.query()).feishuCards.totals.readCards, 1);
});

test('sampler advances bounded pagination without duplicate reads, preserves coverage and durable business failures', async () => {
  const { stateDir, statePath } = await stateFixture('bot-a');
  const store = createUsageEventStore({ directory: join(home, 'sample-ledger') });
  let time = Date.now(), calls = 0;
  const readUsers = async payload => {
    calls++;
    assert.equal(payload.path.message_id, card.messageId);
    if (calls === 1) return { code: 0, data: { items: readers, has_more: true, page_token: 'page-two' } };
    assert.equal(payload.params.page_token, 'page-two');
    return { code: 0, data: { items: readers, has_more: false } };
  };
  const options = { stateDir, statePath, store, resolvePerson, now: () => time, readUsers };
  const sampler = createFeishuCardReadSampler({ config: { sourceRouteId: 'bot-a' } }, options);
  await sampler.tick();
  assert.equal((await readFeishuCardSamplingCoverage(join(home, 'sampling'))).incomplete, true);
  assert.equal(await sampler.tick(), false, 'no fixed waiting and no request before the sampling deadline');
  time += 10_000; await sampler.tick();
  assert.equal(calls, 2);
  assert.equal((await store.query()).feishuCards.totals.readCards, 1);
  assert.equal((await readFeishuCardSamplingCoverage(join(home, 'sampling'))).incomplete, false);
  time += 300_000;
  const failed = createFeishuCardReadSampler({ config: { sourceRouteId: 'bot-a' } }, {
    ...options, readUsers: async () => ({ code: 230001 }) });
  await failed.tick();
  assert.equal((await readFeishuCardSamplingCoverage(join(home, 'sampling'))).incomplete, true);
  time += 300_000;
  const recoveredProcess = createFeishuCardReadSampler({ config: { sourceRouteId: 'bot-a' } }, options);
  assert.equal(await recoveredProcess.tick(), false, 'restart is not evidence to retry a permanent access failure');
  assert.equal(calls, 2);
});

test('sampler bounds temporary failures and never queries cards outside the seven-day API window', async () => {
  const { stateDir, statePath } = await stateFixture('transient');
  let time = Date.now(), calls = 0;
  const sampler = createFeishuCardReadSampler({ config: { sourceRouteId: 'bot-a' } }, {
    stateDir, statePath, now: () => time, readUsers: async () => { calls++; throw Error('network'); } });
  for (let n = 0; n < 4; n++) { await sampler.tick(); time += 60_000; }
  assert.equal(calls, 3);
  const old = createFeishuCardReadSampler({ config: { sourceRouteId: 'bot-a' } }, {
    stateDir, statePath: join(home, 'old.json'), now: () => Date.now() + 8 * 86_400_000,
    readUsers: async () => { throw Error('expired card must never be queried'); } });
  assert.equal(await old.tick(), false);
});
