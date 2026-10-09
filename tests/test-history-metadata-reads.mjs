#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = fs.mkdtempSync(join(tmpdir(), 'remotelab-metadata-reads-'));
setIsolatedTestHome(home);
const originalReadFile = fs.promises.readFile;
let eventReads = 0;
fs.promises.readFile = async function (path, ...args) {
  if (String(path).includes('/events/')) eventReads++;
  return originalReadFile.call(this, path, ...args);
};
syncBuiltinESMExports();

try {
  const history = await import('../chat/history.mjs');
  const { CHAT_HISTORY_DIR } = await import('../lib/config.mjs');
  const { requests } = await import('../chat/requests.mjs');
  const { withSessionsMetaMutation } = await import('../chat/session-meta-store.mjs');
  const { claimSourceDelivery, completeSourceDelivery } = await import('../chat/source-deliveries.mjs');
  const id = 'large-legacy-history';
  const dir = join(CHAT_HISTORY_DIR, id);
  fs.mkdirSync(join(dir, 'events'), { recursive: true });
  fs.writeFileSync(join(dir, 'meta.json'), JSON.stringify({ latestSeq: 10_000, size: 10_000,
    counts: { message_user: 1, message_assistant: 1 }, lastEventAt: 1234 }));
  fs.writeFileSync(join(dir, 'context.json'), JSON.stringify({ mode: 'summary', activeFromSeq: 9_000 }));
  for (let i = 0; i < 5; i++) {
    const snapshot = await history.getHistorySnapshot(id, { metadataOnly: true, includeUserMessageAt: true });
    assert.equal(snapshot.messageCount, 2);
    assert.equal(snapshot.lastUserMessageAt, null, 'missing old timestamps stay unknown on metadata reads');
    assert.equal(snapshot.activeMessageCount, null, 'list reads do not count compacted history');
  }
  assert.equal(eventReads, 0, 'repeated metadata reads must not open historical event files');

  const plan = { connector: 'feishu', sourceRouteId: 'metadata-regression',
    target: { chatId: 'regression-chat', chatType: 'p2p', conversationKind: 'main' } };
  await withSessionsMetaMutation(async (metas, save) => { metas.push({ id, conversation: plan }); await save(metas); });
  const record = (await requests.accept({ sessionId: id, requestId: 'indexed-reply', text: 'request',
    options: { deliveryOnly: true }, result: { state: 'completed', payload: { text: 'reply' } },
    plans: [{ ...plan, kind: 'content', text: 'reply', providerMessageId: 'provider-final' }] })).record;
  const aborted = new AbortController(); aborted.abort();
  assert.equal(await claimSourceDelivery({ connector: 'feishu', sourceRouteId: plan.sourceRouteId, signal: aborted.signal }), null);
  assert.equal((await requests.get(record.key)).deliveries[0].attempts, 0, 'disconnected claims must not acquire a lease');
  const claim = await claimSourceDelivery({ connector: 'feishu', sourceRouteId: plan.sourceRouteId });
  await completeSourceDelivery(claim.delivery.id, claim.leaseId, { externalId: 'om-real-receipt' });
  await completeSourceDelivery(claim.delivery.id, claim.leaseId, { externalId: 'om-real-receipt' });
  assert.equal(eventReads, 0, 'claim, completion and duplicate acknowledgement do not scan the old history');
  const receipts = await history.loadHistory(id, { fromSeq: 10_001 });
  assert.deepEqual(receipts.map(event => event.state), ['sending', 'delivered']);
  const indexed = JSON.parse(fs.readFileSync(join(dir, 'meta.json'), 'utf8'));
  assert.equal(indexed.sourceDeliveryReceiptSeqs[claim.delivery.id], 10_002);
  await history.appendEvent(id, { type: 'status', content: 'after receipt' });
  await history.appendEvents(id, [{ type: 'status', content: 'batch after receipt' }]);
  assert.equal((await history.findSourceDeliveryReceipt(id, claim.delivery.id)).externalId, 'om-real-receipt',
    'later single and batch appends preserve the receipt index');

  const legacy = 'legacy-timestamps';
  const legacyDir = join(CHAT_HISTORY_DIR, legacy);
  fs.mkdirSync(join(legacyDir, 'events'), { recursive: true });
  fs.writeFileSync(join(legacyDir, 'meta.json'), JSON.stringify({ latestSeq: 2, size: 2,
    counts: { message_user: 1, message_assistant: 1 } }));
  fs.writeFileSync(join(legacyDir, 'events', '000000001.json'), JSON.stringify({ seq: 1, type: 'message', role: 'user', timestamp: 111 }));
  fs.writeFileSync(join(legacyDir, 'events', '000000002.json'), JSON.stringify({ seq: 2, type: 'message', role: 'assistant', timestamp: 222 }));
  const snapshots = await Promise.all(Array.from({ length: 5 }, () => history.getHistorySnapshot(legacy, { includeUserMessageAt: true })));
  assert(snapshots.every(snapshot => snapshot.lastUserMessageAt === 111 && snapshot.lastAssistantMessageAt === 222));
  const repaired = JSON.parse(fs.readFileSync(join(legacyDir, 'meta.json'), 'utf8'));
  assert.equal(repaired.lastUserMessageAt, 111, 'explicit reads persist old timestamp recovery');
  assert.equal(repaired.lastAssistantMessageAt, 222);
  assert.equal((await history.getHistorySnapshot(legacy, { metadataOnly: true })).lastUserMessageAt, 111);
  console.log('Metadata/history isolation, indexed delivery receipts, aborted claims and durable timestamp repair passed.');
} finally {
  fs.promises.readFile = originalReadFile;
  syncBuiltinESMExports();
  fs.rmSync(home, { recursive: true, force: true });
}
