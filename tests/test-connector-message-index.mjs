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
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log('ok - connector message index is scoped and rebuildable');
