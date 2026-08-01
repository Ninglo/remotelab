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
} = await import('../connectors/feishu/document-skill.mjs');
const {
  initSkillRegistry,
  registerConnectorSkills,
  deregisterConnectorSkills,
} = await import('../lib/connector-skill-registry.mjs');
const {
  startConnectorSkillServer,
} = await import('../lib/connector-skill-server.mjs');
const {
  runConnectorCommand,
} = await import('../lib/connector-command.mjs');
const {
  buildSystemContext,
} = await import('../chat/system-prompt.mjs');

const documentSkill = FEISHU_SKILLS.find((skill) => skill.name === 'document_get');
assert.ok(documentSkill, 'Feishu should declare a read-only document_get capability');
assert.equal(documentSkill.schema.documentToken.required, true);

const documentUrl = 'https://example.feishu.cn/docx/DOCtoken123456789';
assert.equal(extractFeishuDocumentToken(documentUrl), 'DOCtoken123456789');
assert.equal(extractFeishuDocumentToken('DOCtoken123456789'), 'DOCtoken123456789');
assert.equal(extractFeishuDocumentToken(`请读取 ${documentUrl} 的结论`), 'DOCtoken123456789');
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
const runtime = {
  appClient: {
    docx: {
      v1: {
        document: {
          async get(payload) {
            calls.push(['get', payload.path.document_id]);
            return {
              code: 0,
              data: {
                document: {
                  document_id: payload.path.document_id,
                  revision_id: 42,
                  title: '表征实验',
                },
              },
            };
          },
          async rawContent(payload) {
            calls.push(['rawContent', payload.path.document_id]);
            return { code: 0, data: { content: '第一段\n第二段\n第三段' } };
          },
        },
      },
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
assert.deepEqual(calls.sort(), [
  ['get', 'DOCtoken123456789'],
  ['rawContent', 'DOCtoken123456789'],
].sort());

await assert.rejects(
  () => readFeishuDocument({
    appClient: {
      docx: {
        v1: {
          document: {
            async get() {
              const error = new Error('forbidden');
              error.response = { status: 403, data: { code: 91403, msg: 'Forbidden' } };
              throw error;
            },
            async rawContent() {
              return { code: 0, data: { content: '' } };
            },
          },
        },
      },
    },
  }, { documentToken: 'DOCtoken123456789' }),
  (error) => error?.code === 'document_permission_denied' && error?.statusCode === 403,
);

await initSkillRegistry(process.env.REMOTELAB_CONFIG_DIR);
const callbackToken = 'test-connector-callback-token';
const skillServer = await startConnectorSkillServer({
  channel: 'feishu',
  token: callbackToken,
  skills: [documentSkill],
  onSkill: async (skillName, body) => {
    assert.equal(skillName, 'document_get');
    return await readFeishuDocument(runtime, body.parameters);
  },
});

try {
  const unauthorized = await fetch(`${skillServer.skillUrl}/document_get`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parameters: { documentToken: documentUrl } }),
  });
  assert.equal(unauthorized.status, 401);

  await registerConnectorSkills('feishu', {
    callback: {
      skillUrl: skillServer.skillUrl,
      token: callbackToken,
    },
    skills: [documentSkill],
  });

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
} finally {
  await deregisterConnectorSkills('feishu');
  await skillServer.stop();
  await rm(tempRoot, { recursive: true, force: true });
}

console.log('test-feishu-document-skill: ok');
