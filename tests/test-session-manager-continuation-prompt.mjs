#!/usr/bin/env node
import assert from 'assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'remotelab-continuation-prompt-'));
setIsolatedTestHome(tempHome);

const workspace = path.join(tempHome, 'workspace');
await fs.mkdir(workspace, { recursive: true });

const { createSession, buildPrompt, killAll } = await import('../chat/session-manager.mjs');
const { setContextHead, setForkContext } = await import('../chat/history.mjs');

try {
  const session = await createSession(workspace, 'codex', 'Continuation prompt test');

  await setContextHead(session.id, {
    mode: 'summary',
    summary: '已有会话摘要。',
    activeFromSeq: 0,
    toolIndex: 'shell\napply_patch',
    updatedAt: '2026-03-14T13:10:00.000Z',
    source: 'manual',
  });

  await setForkContext(session.id, {
    mode: 'summary',
    summary: '已有会话摘要。',
    continuationBody: '[User]\n继续推进。',
    activeFromSeq: 0,
    preparedThroughSeq: 0,
    updatedAt: '2026-03-14T13:20:00.000Z',
    source: 'manual',
  });

  const prompt = await buildPrompt(
    session.id,
    session,
    '继续执行。',
    'codex',
    'codex',
    null,
    {},
  );

  assert.match(prompt, /\[Conversation summary\]/);
  assert.match(prompt, /已有会话摘要/);
  assert.match(prompt, /Treat it as the authoritative context/);
  assert.match(prompt, /Earlier tool activity index/);
  assert.match(prompt, /Current user message:/);

  console.log('test-session-manager-continuation-prompt: ok');
} finally {
  await killAll();
}
