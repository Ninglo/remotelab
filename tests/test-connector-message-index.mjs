#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  findConnectorMessageIndexRecord,
  upsertConnectorMessageIndexRecord,
} from '../lib/connector-message-index.mjs';

const tempDir = await mkdtemp(join(tmpdir(), 'remotelab-connector-index-'));
const indexPath = join(tempDir, 'connector-message-index.json');

try {
  await upsertConnectorMessageIndexRecord(indexPath, {
    connector: 'feishu',
    accountId: 'tenant-1',
    messageId: 'message-1',
    sessionId: 'session-1',
    chatId: 'chat-1',
    direction: 'inbound',
  });
  const match = await findConnectorMessageIndexRecord(indexPath, {
    connector: 'feishu',
    accountId: 'tenant-1',
    messageId: 'message-1',
    chatId: 'chat-1',
  });
  assert.equal(match?.sessionId, 'session-1');
  assert.equal(match?.direction, 'inbound');

  const wrongChat = await findConnectorMessageIndexRecord(indexPath, {
    connector: 'feishu',
    accountId: 'tenant-1',
    messageId: 'message-1',
    chatId: 'chat-2',
  });
  assert.equal(wrongChat, null);

  await upsertConnectorMessageIndexRecord(indexPath, {
    connector: 'feishu', messageId: 'legacy', sessionId: 'legacy-session',
    chatId: 'chat-1', conversationId: 'topic-1',
  });
  const batch = await Promise.all([
    { connector: 'feishu', accountId: 'tenant-1', messageId: 'message-1', chatId: 'chat-1' },
    { connector: 'feishu', accountId: 'tenant-2', messageId: 'message-1' },
    { connector: 'feishu', accountId: 'tenant-1', messageId: 'legacy', conversationId: 'topic-1' },
    { connector: 'feishu', messageId: 'legacy', conversationId: 'other-topic' },
    { connector: 'other', messageId: 'message-1' },
    {},
  ].map(query => findConnectorMessageIndexRecord(indexPath, query)));
  assert.deepEqual(batch.map(record => record?.sessionId || null),
    ['session-1', null, 'legacy-session', null, null, null], 'individual lookup preserves scope, legacy fallback and query order');
  await upsertConnectorMessageIndexRecord(indexPath, {
    connector: 'feishu', accountId: 'tenant-1', messageId: 'message-1', sessionId: 'updated-session',
  });
  assert.equal((await Promise.all([
    { connector: 'feishu', accountId: 'tenant-1', messageId: 'message-1' },
  ].map(query => findConnectorMessageIndexRecord(indexPath, query))))[0].sessionId, 'updated-session', 'later lookups read newly committed bindings');

  await Promise.all(Array.from({ length: 12 }, (_, index) => upsertConnectorMessageIndexRecord(indexPath, {
    connector: 'feishu', accountId: 'tenant-1', messageId: `parallel-${index}`,
    sessionId: `session-${index}`, chatId: `chat-${index}`, direction: 'binding',
  })));
  for (let index = 0; index < 12; index++) {
    const concurrent = await findConnectorMessageIndexRecord(indexPath, {
      connector: 'feishu', accountId: 'tenant-1', messageId: `parallel-${index}`,
    });
    assert.equal(concurrent?.sessionId, `session-${index}`, 'parallel topics retain every routing binding');
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log('ok - connector message index is scoped and rebuildable');
