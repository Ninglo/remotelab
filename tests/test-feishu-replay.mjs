#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { loadReplayableSummariesByMessageIds } from '../lib/feishu-replay.mjs';

const tempDir = await mkdtemp(join(tmpdir(), 'remotelab-feishu-replay-'));

try {
  const eventsPath = join(tempDir, 'events.jsonl');
  await writeFile(eventsPath, [
    JSON.stringify({ allowed: true, summary: { messageId: 'message-1', chatId: 'chat-1', textPreview: 'old' } }),
    JSON.stringify({ allowed: false, summary: { messageId: 'message-2', chatId: 'chat-1' } }),
    '{not json}',
    JSON.stringify({ allowed: true, summary: { messageId: 'message-3', chatId: 'chat-1' } }),
    JSON.stringify({ allowed: true, summary: { messageId: 'message-1', chatId: 'chat-1', textPreview: 'latest' } }),
    '',
  ].join('\n'));

  const result = await loadReplayableSummariesByMessageIds(
    eventsPath,
    ['message-3', 'message-1', 'message-2', 'message-3'],
  );

  assert.deepEqual(result.summaries.map((summary) => summary.messageId), ['message-3', 'message-1']);
  assert.equal(result.summaries[1].textPreview, 'latest');
  assert.deepEqual(result.missingMessageIds, ['message-2']);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log('test-feishu-replay: ok');
