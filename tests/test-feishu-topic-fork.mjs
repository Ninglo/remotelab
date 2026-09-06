#!/usr/bin/env node
import assert from 'assert/strict';
import http from 'http';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  findFeishuThreadSessionBinding,
  recordFeishuThreadSessionBinding,
} from '../connectors/feishu/session-flow.mjs';
import { generateRemoteLabReply } from '../scripts/feishu-connector.mjs';

const tempDir = await mkdtemp(join(tmpdir(), 'remotelab-feishu-topic-fork-'));
const runtime = {
  storagePaths: {
    messageIndexPath: join(tempDir, 'connector-message-index.json'),
  },
};

try {
  const summary = {
    tenantKey: 'tenant-1',
    chatType: 'group',
    chatId: 'chat-1',
    messageId: 'topic-child-message',
    rootId: 'topic-root-message',
    parentId: 'bot-reply-message',
    threadId: 'topic-thread-1',
  };

  assert.equal(
    await findFeishuThreadSessionBinding(runtime, summary),
    null,
    'an unknown Thread must not guess a parent Session',
  );

  const stored = await recordFeishuThreadSessionBinding(runtime, summary, 'fork-session-1', {
    externalTriggerId: 'feishu:fork:bot-1:tenant-1:chat-1:fork-command-message',
  });
  assert.equal(stored?.sessionId, 'fork-session-1');
  assert.equal(stored?.messageId, 'thread:topic-thread-1');

  const found = await findFeishuThreadSessionBinding(runtime, {
    ...summary,
    messageId: 'later-thread-message',
    rootId: 'different-root-value',
    parentId: 'different-parent-value',
  });
  assert.equal(found?.sessionId, 'fork-session-1');
  assert.equal(found?.externalTriggerId, 'feishu:fork:bot-1:tenant-1:chat-1:fork-command-message');

  assert.equal(
    await findFeishuThreadSessionBinding(runtime, {
      ...summary,
      tenantKey: 'tenant-2',
    }),
    null,
    'bindings must remain isolated by tenant',
  );

  assert.equal(
    await findFeishuThreadSessionBinding(runtime, {
      ...summary,
      chatId: 'chat-2',
    }),
    null,
    'bindings must remain isolated by chat',
  );

  assert.equal(
    await findFeishuThreadSessionBinding(runtime, {
      tenantKey: 'tenant-1',
      chatType: 'group',
      chatId: 'chat-1',
      messageId: 'plain-reply',
      rootId: 'quoted-message',
    }),
    null,
    'a plain quoted reply must not be treated as a Thread',
  );

  let createCount = 0;
  const createdPayloads = [];
  const submittedPayloads = [];
  const requestedPaths = [];
  const server = http.createServer(async (req, res) => {
    requestedPaths.push(`${req.method} ${req.url}`);
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    const payload = body ? JSON.parse(body) : null;

    if (req.method === 'POST' && req.url === '/api/sessions') {
      createCount += 1;
      createdPayloads.push(payload);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ session: { id: 'fork-session-2' } }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/sessions/fork-session-2/messages') {
      submittedPayloads.push(payload);
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        response: { id: payload.requestId },
        run: { id: `run-${submittedPayloads.length}` },
        duplicate: false,
        queued: false,
      }));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/sessions/fork-session-2/responses/')) {
      const responseId = decodeURIComponent(req.url.split('/').at(-1));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        replyPublication: {
          id: responseId,
          state: 'ready',
          ready: true,
          finalRunId: `run-${submittedPayloads.length}`,
          payload: { text: `reply-${submittedPayloads.length}` },
        },
      }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const commandSummary = {
      tenantKey: 'tenant-1',
      chatType: 'group',
      chatId: 'chat-1',
      messageId: 'fork-command-message',
      messageType: 'text',
      forkCommand: true,
      forkText: '分析当前问题\n然后给出修复方案',
      replyInThread: true,
      sender: { tenantKey: 'tenant-1' },
    };
    const connectorRuntime = {
      authCookie: 'session_token=test',
      config: {
        chatBaseUrl: `http://127.0.0.1:${server.address().port}`,
        sourceRouteId: 'bot-1',
        sessionFolder: process.cwd(),
        sessionTool: 'codex',
        runtimeSelectionMode: 'pinned',
        systemPrompt: 'Feishu test prompt.',
        region: 'feishu-cn',
      },
      storagePaths: runtime.storagePaths,
    };

    const forkReply = await generateRemoteLabReply(connectorRuntime, commandSummary);
    assert.equal(forkReply.sessionId, 'fork-session-2');
    assert.equal(forkReply.externalTriggerId, 'feishu:fork:bot-1:tenant-1:chat-1:fork-command-message');
    assert.equal(createCount, 1);
    assert.equal(
      requestedPaths.some((entry) => /POST \/api\/sessions\/[^/]+\/fork$/.test(entry)),
      false,
      '/fork must create a blank Session instead of calling the history-copy endpoint',
    );
    assert.deepEqual(createdPayloads[0].sourceContext, {
      connector: 'feishu',
      sourceRouteId: 'bot-1',
      chatType: 'group',
      chatId: 'chat-1',
      messageId: 'fork-command-message',
    });
    assert.equal(submittedPayloads[0].text, '分析当前问题\n然后给出修复方案');
    assert.deepEqual(submittedPayloads[0].sourceContext, createdPayloads[0].sourceContext);

    await recordFeishuThreadSessionBinding(connectorRuntime, commandSummary, forkReply.sessionId, {
      threadId: 'created-thread-1',
      externalTriggerId: forkReply.externalTriggerId,
    });
    const continuationReply = await generateRemoteLabReply(connectorRuntime, {
      tenantKey: 'tenant-1',
      chatType: 'group',
      chatId: 'chat-1',
      messageId: 'later-thread-message',
      messageType: 'text',
      messageText: '继续',
      textPreview: '继续',
      threadId: 'created-thread-1',
      sender: { tenantKey: 'tenant-1' },
    });
    assert.equal(continuationReply.sessionId, 'fork-session-2');
    assert.equal(createCount, 1, 'later Thread messages should use the explicit binding');
    assert.equal(submittedPayloads[1].text, '继续\n\n[Feishu source reference: message_id=later-thread-message, message_type=text, thread_id=created-thread-1]');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('ok - Feishu Thread bindings are explicit and never guessed');
  console.log('ok - /fork creates a blank Session with minimal Feishu metadata');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
