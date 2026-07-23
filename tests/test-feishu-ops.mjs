#!/usr/bin/env node
import assert from 'assert/strict';
import { join } from 'path';
import { pathToFileURL } from 'url';

const repoRoot = process.cwd();

const {
  buildBackfillPrompt,
  buildMessageRecords,
  formatFeishuApiError,
  parseArgs,
  parseJsonLines,
  parseSystemdExecStartConfigPath,
  selectBackfillMessages,
} = await import(pathToFileURL(join(repoRoot, 'scripts', 'feishu-ops.mjs')).href);

const parsed = parseArgs(['backfill', '--count', '3', '--tool', 'micro-agent', '--model', 'gpt-5.4', '--effort', 'low', '--dry-run']);
assert.equal(parsed.command, 'backfill');
assert.equal(parsed.count, 3);
assert.equal(parsed.tool, 'micro-agent');
assert.equal(parsed.model, 'gpt-5.4');
assert.equal(parsed.effort, 'low');
assert.equal(parsed.dryRun, true);

const botTargeted = parseArgs([
  'restart',
  '--bot', 'bot-b',
  '--registry', '/srv/remotelab/feishu-bots.json',
]);
assert.equal(botTargeted.botId, 'bot-b');
assert.equal(botTargeted.registryPath, '/srv/remotelab/feishu-bots.json');

assert.equal(
  parseSystemdExecStartConfigPath('{ path=/usr/bin/node ; argv[]=/usr/bin/node /opt/remotelab/scripts/feishu-connector.mjs --config /srv/remotelab/feishu/config.json ; }'),
  '/srv/remotelab/feishu/config.json',
);
assert.equal(
  parseSystemdExecStartConfigPath('/usr/bin/node connector.mjs --config="/srv/remotelab/feishu bot/config.json"'),
  '/srv/remotelab/feishu bot/config.json',
);
assert.equal(parseSystemdExecStartConfigPath('/usr/bin/node connector.mjs'), '');

const jsonLines = parseJsonLines('{"ok":1}\nnot-json\n{"ok":2}\n');
assert.equal(jsonLines.records.length, 2);
assert.equal(jsonLines.invalidLines, 1);

const records = buildMessageRecords([
  {
    receivedAt: '2026-03-21T10:00:00.000Z',
    allowed: true,
    sourceLabel: 'im.message.receive_v1',
    summary: {
      messageId: 'msg-1',
      chatId: 'chat-a',
      chatType: 'group',
      messageType: 'text',
      textPreview: '第一条',
      sender: { openId: 'ou_1' },
    },
  },
  {
    receivedAt: '2026-03-21T10:01:00.000Z',
    allowed: true,
    sourceLabel: 'im.message.receive_v1',
    summary: {
      messageId: 'msg-2',
      chatId: 'chat-a',
      chatType: 'group',
      messageType: 'text',
      textPreview: '第二条',
      sender: { openId: 'ou_1' },
    },
  },
  {
    receivedAt: '2026-03-21T10:02:00.000Z',
    allowed: true,
    sourceLabel: 'im.message.receive_v1',
    summary: {
      messageId: 'msg-3',
      chatId: 'chat-b',
      chatType: 'group',
      messageType: 'text',
      textPreview: '第三条',
      sender: { openId: 'ou_2' },
    },
  },
  {
    receivedAt: '2026-03-21T10:03:00.000Z',
    allowed: true,
    sourceLabel: 'im.message.receive_v1',
    summary: {
      messageId: 'msg-4',
      chatId: 'chat-b',
      chatType: 'group',
      messageType: 'image',
      contentSummary: 'Image attachment',
      sender: { openId: 'ou_2' },
    },
  },
], {
  'msg-1': { status: 'sent' },
  'msg-2': { status: 'silent_no_reply' },
  'msg-3': { status: 'silent_no_reply' },
  'msg-4': { status: 'silent_no_reply' },
});

assert.equal(records.length, 4);
assert.equal(records[1].handled.status, 'silent_no_reply');
assert.equal(records[3].messageType, 'image');

const latestSelection = selectBackfillMessages(records, { count: 2 });
assert.equal(latestSelection.chatId, 'chat-b');
assert.deepEqual(latestSelection.messages.map((record) => record.messageId), ['msg-3']);

const chatSelection = selectBackfillMessages(records, { chatId: 'chat-a', count: 2 });
assert.deepEqual(chatSelection.messages.map((record) => record.messageId), ['msg-2']);

const targetedSelection = selectBackfillMessages([
  ...records,
  {
    ...records[2],
    messageId: 'msg-5',
    receivedAt: '2026-03-21T10:04:00.000Z',
    text: '第四条',
    handled: { status: 'silent_no_reply' },
  },
], { messageId: 'msg-5', count: 2 });
assert.deepEqual(targetedSelection.messages.map((record) => record.messageId), ['msg-3', 'msg-5']);

const prompt = buildBackfillPrompt(targetedSelection.messages);
assert.match(prompt, /之前收到但没有回复的 2 条消息/);
assert.match(prompt, /1\. 第三条/);
assert.match(prompt, /2\. 第四条/);
assert.match(prompt, /只输出一条适合现在直接发回该飞书聊天的中文消息/);

const formattedError = formatFeishuApiError({
  response: {
    data: {
      code: 230002,
      msg: 'Bot/User can NOT be out of the chat.',
    },
  },
});
assert.equal(formattedError, 'Bot/User can NOT be out of the chat. (code 230002)');

console.log('ok');
