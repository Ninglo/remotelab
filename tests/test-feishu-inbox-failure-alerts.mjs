import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInboxFailureAlerts, INBOX_FAILURE_ALERT_INTERVAL_MS } from '../connectors/feishu/inbox-failure-alerts.mjs';

const root = await mkdtemp(join(tmpdir(), 'inbox-alerts-'));
try {
  let clock = 1_000_000, calls = 0;
  const entry = { id: 'event-one', lastError: 'duplicate identity', summary: {
    sourceKind: 'personal_chat_entered', chatId: 'private', tenantKey: 'tenant', sender: { openId: 'one' },
  } };
  let notify = createInboxFailureAlerts(root, { now: () => clock });
  const send = async id => { calls++; return { deliveryId: id }; };
  await Promise.all(Array.from({ length: 5 }, (_, i) => notify('bot', { ...entry, id: `event-${i}` }, send)));
  assert.equal(calls, 1, 'different source event IDs share the same incident');
  notify = createInboxFailureAlerts(root, { now: () => clock });
  clock += INBOX_FAILURE_ALERT_INTERVAL_MS - 1;
  assert.equal((await notify('bot', entry, send)).suppressed, true, 'restart retains the cooldown');
  clock++;
  await notify('bot', entry, send);
  assert.equal(calls, 2, 'one reminder is allowed after three hours');
  await notify('bot', { ...entry, lastError: 'different failure' }, send);
  assert.equal(calls, 3, 'a different failure remains visible');
  const uncertain = { ...entry, lastError: 'lost enqueue acknowledgement' };
  let firstId;
  await assert.rejects(notify('bot', uncertain, async id => { firstId = id; throw Error('lost acknowledgement'); }));
  notify = createInboxFailureAlerts(root, { now: () => clock + 1000 });
  await notify('bot', uncertain, async id => { assert.equal(id, firstId, 'retry reuses the durable delivery ID'); return { deliveryId: id }; });
  console.log('Feishu inbox alert grouping, three-hour persistence and uncertain delivery recovery: passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
