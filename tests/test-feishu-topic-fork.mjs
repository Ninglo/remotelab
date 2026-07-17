#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { upsertConnectorMessageIndexRecord } from '../lib/connector-message-index.mjs';
import { resolveFeishuTopicForkParentSessionId } from '../connectors/feishu/session-flow.mjs';

const tempDir = await mkdtemp(join(tmpdir(), 'remotelab-feishu-topic-fork-'));
const indexPath = join(tempDir, 'connector-message-index.json');
const summary = {
  tenantKey: 'tenant-1',
  chatType: 'group',
  chatId: 'chat-1',
  messageId: 'topic-child-message',
  rootId: 'independent-topic-root',
  parentId: 'bot-reply-message',
  threadId: 'topic-thread-1',
};

try {
  await upsertConnectorMessageIndexRecord(indexPath, {
    connector: 'feishu',
    accountId: 'tenant-1',
    messageId: 'bot-reply-message',
    sessionId: 'parent-session',
    chatId: 'chat-1',
    sourceMessageId: 'original-user-message',
    direction: 'outbound',
  });

  const requester = async (path) => {
    if (path === '/api/sessions/parent-session') {
      return {
        response: { ok: true },
        json: { session: { id: 'parent-session', sourceId: 'feishu', sourceContext: { chatId: 'chat-1' } } },
      };
    }
    if (path === '/api/sessions/parent-session/events?filter=all') {
      return {
        response: { ok: true },
        json: { events: [{ sourceContext: { connector: 'feishu', messageId: 'original-user-message' } }] },
      };
    }
    if (path === '/api/sessions?sourceId=feishu') {
      return { response: { ok: true }, json: { sessions: [] } };
    }
    return { response: { ok: false }, json: null };
  };

  const parentSessionId = await resolveFeishuTopicForkParentSessionId(
    { storagePaths: { messageIndexPath: indexPath } },
    requester,
    summary,
  );
  assert.equal(parentSessionId, 'parent-session', 'bot reply parent should resolve even when topic root has a different id');

  const staleIndexPath = join(tempDir, 'stale-index.json');
  await upsertConnectorMessageIndexRecord(staleIndexPath, {
    connector: 'feishu',
    accountId: 'tenant-1',
    messageId: 'bot-reply-message',
    sessionId: 'stale-session',
    chatId: 'chat-1',
    sourceMessageId: 'missing-message',
  });
  const factRequester = async (path) => {
    if (path === '/api/sessions?sourceId=feishu') {
      return {
        response: { ok: true },
        json: { sessions: [{ id: 'fact-session', sourceId: 'feishu', externalTriggerId: 'feishu:group:chat-1' }] },
      };
    }
    if (path === '/api/sessions/fact-session') {
      return {
        response: { ok: true },
        json: { session: { id: 'fact-session', sourceId: 'feishu', sourceContext: { chatId: 'chat-1' } } },
      };
    }
    if (path === '/api/sessions/fact-session/events?filter=all') {
      return {
        response: { ok: true },
        json: { events: [{ sourceContext: { connector: 'feishu', messageId: 'bot-reply-message' } }] },
      };
    }
    return { response: { ok: false }, json: null };
  };
  const factSessionId = await resolveFeishuTopicForkParentSessionId(
    { storagePaths: { messageIndexPath: staleIndexPath } },
    factRequester,
    summary,
  );
  assert.equal(factSessionId, 'fact-session', 'stale cache entries must not override session/event facts');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log('ok - Feishu topic fork verifies cache hits against session facts');
