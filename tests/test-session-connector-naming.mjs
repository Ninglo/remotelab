#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-session-connector-naming-'));

process.env.HOME = tempHome;

const sessionManager = await import(
  pathToFileURL(join(repoRoot, 'chat', 'session-manager.mjs')).href
);

const {
  createSession,
  killAll,
} = sessionManager;

const baseFolder = join(tempHome, 'workspace');

try {
  const genericFeishu = await createSession(baseFolder, 'codex', 'Feishu group', {
    sourceId: 'feishu',
    sourceName: 'Feishu',
    group: 'Feishu',
    externalTriggerId: 'feishu:group:chat_1',
  });
  assert.equal(genericFeishu.name, 'new session', 'generic connector titles should stay temporary');
  assert.equal(genericFeishu.autoRenamePending, true, 'generic connector titles should remain auto-renameable');

  const explicitGithub = await createSession(baseFolder, 'codex', 'GitHub: owner/repo#7 — macOS build failure', {
    sourceId: 'github',
    sourceName: 'GitHub',
    group: 'GitHub',
    externalTriggerId: 'github:owner/repo#7',
  });
  assert.equal(
    explicitGithub.name,
    'owner/repo#7 — macOS build failure',
    'connector titles should drop redundant group/provider prefixes while keeping explicit context',
  );
  assert.equal(explicitGithub.autoRenamePending, false, 'explicit connector titles should not stay pending');

  const explicitChinese = await createSession(baseFolder, 'codex', '飞书：支付接口报错', {
    sourceId: 'feishu',
    sourceName: '飞书',
    group: '飞书',
    externalTriggerId: 'feishu:group:chat_2',
  });
  assert.equal(explicitChinese.name, '支付接口报错', 'Chinese connector titles should also drop redundant group prefixes');
  assert.equal(explicitChinese.autoRenamePending, false, 'explicit Chinese connector titles should be preserved');

  const upgradedReuse = await createSession(baseFolder, 'codex', 'Feishu group', {
    sourceId: 'feishu',
    sourceName: 'Feishu',
    group: 'Feishu',
    externalTriggerId: 'feishu:group:chat_3',
  });
  assert.equal(upgradedReuse.name, 'new session');
  assert.equal(upgradedReuse.autoRenamePending, true);

  const enrichedReuse = await createSession(baseFolder, 'codex', '飞书：修复支付回调', {
    sourceId: 'feishu',
    sourceName: '飞书',
    group: '飞书',
    externalTriggerId: 'feishu:group:chat_3',
  });
  assert.equal(enrichedReuse.id, upgradedReuse.id, 'same external trigger should still reuse the existing session');
  assert.equal(enrichedReuse.name, '修复支付回调', 'reused pending connector sessions should accept later explicit context');
  assert.equal(enrichedReuse.autoRenamePending, false, 'later explicit context should clear pending auto-rename');

  const chatVisitor = await createSession(baseFolder, 'codex', 'Template Agent', {
    templateId: 'visitor-template',
    templateName: 'Template Agent',
    sourceId: 'chat',
    sourceName: 'Chat',
    externalTriggerId: 'visitor_session:template:visitor_1',
  });
  assert.equal(chatVisitor.name, 'Template Agent', 'chat-origin sessions should keep their explicit titles');
  assert.equal(chatVisitor.autoRenamePending, false, 'chat-origin sessions should not be forced into connector title rules');

  console.log('test-session-connector-naming: ok');
} finally {
  killAll();
  rmSync(tempHome, { recursive: true, force: true });
}
