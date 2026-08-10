#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoot = await mkdtemp(join(tmpdir(), 'remotelab-feishu-document-skill-'));
process.env.HOME = tempRoot;
process.env.REMOTELAB_CONFIG_DIR = join(tempRoot, 'config');
process.env.REMOTELAB_MEMORY_DIR = join(tempRoot, 'memory');
process.env.REMOTELAB_WORK_ROOT_DIR = join(tempRoot, 'workspace');

const {
  FEISHU_SKILLS,
  extractFeishuDocumentToken,
  summarizeFeishuEvent,
} = await import('../connectors/feishu/index.mjs');
const {
  readFeishuDocument,
  startFeishuDocumentCapability,
} = await import('../connectors/feishu/document-skill.mjs');
const {
  initSkillRegistry,
} = await import('../lib/connector-skill-registry.mjs');
const {
  runConnectorCommand,
} = await import('../lib/connector-command.mjs');
const {
  buildSystemContext,
} = await import('../chat/system-prompt.mjs');

const documentSkill = FEISHU_SKILLS.find((skill) => skill.name === 'document_get');
assert.ok(documentSkill, 'Feishu should declare a read-only document_get capability');
assert.equal(documentSkill.schema.documentToken.required, true);
assert.equal(documentSkill.schema.scope.type, 'string');
assert.equal(documentSkill.schema.startBlockId.type, 'string');
assert.equal(documentSkill.schema.keyword.type, 'string');
assert.equal(documentSkill.schema.downloadMedia.type, 'boolean');

const documentUrl = 'https://example.feishu.cn/docx/DOCtoken123456789';
const wikiUrl = 'https://example.feishu.cn/wiki/WIKItoken123456789';
assert.equal(extractFeishuDocumentToken(documentUrl), 'DOCtoken123456789');
assert.equal(extractFeishuDocumentToken(wikiUrl), 'WIKItoken123456789');
assert.equal(extractFeishuDocumentToken('DOCtoken123456789'), 'DOCtoken123456789');
assert.equal(extractFeishuDocumentToken(`请读取 ${documentUrl} 的结论`), 'DOCtoken123456789');
assert.equal(extractFeishuDocumentToken(`请读取 ${wikiUrl} 的结论`), 'WIKItoken123456789');
assert.equal(extractFeishuDocumentToken('ordinary message'), '');

const postSummary = summarizeFeishuEvent({
  message: {
    chat_id: 'oc_doc_chat',
    chat_type: 'group',
    message_id: 'om_doc_message',
    message_type: 'post',
    content: JSON.stringify({
      zh_cn: {
        content: [[
          { tag: 'text', text: '请分析：' },
          { tag: 'a', text: '表征实验', href: documentUrl },
        ]],
      },
    }),
  },
});
assert.equal(postSummary.messageText, `请分析：表征实验 (${documentUrl})`);

const calls = [];
let providerInitializations = 0;
const runtime = {
  config: {
    appId: 'test-app-id',
    appSecret: 'test-app-secret',
    region: 'feishu-cn',
    sourceRouteId: 'default',
    storageDir: tempRoot,
  },
  documentProvider: {
    async initialize() {
      providerInitializations += 1;
    },
    async fetch(parameters) {
      calls.push(parameters);
      const fullContent = '第一段\n第二段\n第三段';
      const maxChars = Number(parameters.maxChars) || 120_000;
      return {
        documentToken: 'DOCtoken123456789',
        documentId: 'DOCtoken123456789',
        title: '表征实验',
        revisionId: 42,
        content: fullContent.slice(0, maxChars),
        contentLength: fullContent.length,
        truncated: fullContent.length > maxChars,
        identity: 'bot',
        scope: parameters.scope || 'full',
        detail: parameters.detail || 'simple',
        docFormat: parameters.docFormat || 'xml',
        contentPath: join(tempRoot, 'document.xml'),
        manifestPath: join(tempRoot, 'manifest.json'),
        media: [],
      };
    },
  },
};

const document = await readFeishuDocument(runtime, {
  documentToken: documentUrl,
  maxChars: 6,
});
assert.equal(document.documentToken, 'DOCtoken123456789');
assert.equal(document.title, '表征实验');
assert.equal(document.revisionId, 42);
assert.equal(document.content, '第一段\n第二');
assert.equal(document.contentLength, 11);
assert.equal(document.truncated, true);
assert.equal(document.identity, 'bot');
assert.equal(calls.length, 1);
assert.equal(calls[0].documentToken, documentUrl);
assert.equal(calls[0].maxChars, 6);

await readFeishuDocument(runtime, { documentToken: wikiUrl });
assert.equal(calls[1].documentToken, wikiUrl);

await assert.rejects(
  () => readFeishuDocument({
    documentProvider: {
      async fetch() {
        const error = new Error('forbidden');
        error.code = 'document_permission_denied';
        error.statusCode = 403;
        throw error;
      },
    },
  }, { documentToken: 'DOCtoken123456789' }),
  (error) => error?.code === 'document_permission_denied' && error?.statusCode === 403,
);

await initSkillRegistry(process.env.REMOTELAB_CONFIG_DIR);
const documentCapability = await startFeishuDocumentCapability(runtime, {
  configDir: process.env.REMOTELAB_CONFIG_DIR,
  documentProvider: runtime.documentProvider,
});

try {
  assert.equal(providerInitializations, 1);
  const unauthorized = await fetch(`${documentCapability.skillUrl}/document_get`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parameters: { documentToken: documentUrl } }),
  });
  assert.equal(unauthorized.status, 401);

  let stdout = '';
  const exitCode = await runConnectorCommand([
    'call',
    'feishu:document_get',
    '--document-token', documentUrl,
    '--max-chars', '1000',
    '--json',
  ], {
    stdout: { write(chunk) { stdout += String(chunk); } },
  });
  assert.equal(exitCode, 0);
  const cliResult = JSON.parse(stdout);
  assert.equal(cliResult.success, true);
  assert.equal(cliResult.result.title, '表征实验');
  assert.equal(cliResult.result.content, '第一段\n第二段\n第三段');

  const systemContext = await buildSystemContext({ sessionId: 'session-feishu-doc-test' });
  assert.match(systemContext, /### Feishu Documents/);
  assert.match(systemContext, /remotelab connector call feishu:document_get/);
  assert.match(systemContext, /bot identity/);
  assert.match(systemContext, /--scope outline/);
  assert.match(systemContext, /contentPath/);
  assert.match(systemContext, /download-media/);
} finally {
  await documentCapability.stop();
  await rm(tempRoot, { recursive: true, force: true });
}

console.log('test-feishu-document-skill: ok');
