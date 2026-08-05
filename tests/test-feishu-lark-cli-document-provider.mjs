#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';

import {
  createLarkCliDocumentProvider,
} from '../connectors/feishu/lark-cli-document-provider.mjs';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(packageJson.dependencies['@larksuite/cli'], '1.0.61', 'lark-cli must remain an exact, reviewable production dependency');
assert.equal(
  packageJson.overrides['@larksuite/cli']['@clack/prompts'],
  '1.2.0',
  'lark-cli prompts must remain compatible with RemoteLab\'s Node 18 runtime floor',
);

const tempRoot = await mkdtemp(join(tmpdir(), 'remotelab-feishu-lark-cli-provider-'));
const calls = [];

async function runCommand(request) {
  calls.push({
    ...request,
    env: {
      LARKSUITE_CLI_CONFIG_DIR: request.env?.LARKSUITE_CLI_CONFIG_DIR,
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: request.env?.LARKSUITE_CLI_NO_UPDATE_NOTIFIER,
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: request.env?.LARKSUITE_CLI_NO_SKILLS_NOTIFIER,
      OPENCLAW_HOME: request.env?.OPENCLAW_HOME,
      LARK_CHANNEL_CONFIG: request.env?.LARK_CHANNEL_CONFIG,
    },
  });
  if (request.args[0] === 'config') {
    return { stdout: JSON.stringify({ ok: true }), stderr: '' };
  }
  if (request.args[1] === '+fetch') {
    return {
      stdout: JSON.stringify({
        ok: true,
        identity: 'bot',
        data: {
          document: {
            document_id: 'DOCtoken123456789',
            revision_id: 42,
            content: [
              '<title>表征实验</title>',
              '<h1 id="headingA">实验结论</h1>',
              '<p>第一段第二段第三段</p>',
              '<img token="img_token_1" width="640" height="480"/>',
              '<whiteboard token="wb_token_1"/>',
            ].join(''),
          },
        },
      }),
      stderr: '',
    };
  }
  if (request.args[1] === '+media-download') {
    const outputIndex = request.args.indexOf('--output');
    const output = request.args[outputIndex + 1];
    const typeIndex = request.args.indexOf('--type');
    const type = request.args[typeIndex + 1];
    const extension = type === 'whiteboard' ? '.png' : '.jpg';
    await writeFile(join(request.cwd, `${output}${extension}`), `fake-${type}`);
    return {
      stdout: JSON.stringify({ ok: true, identity: 'bot', data: { output: `${output}${extension}` } }),
      stderr: '',
    };
  }
  throw new Error(`Unexpected lark-cli arguments: ${request.args.join(' ')}`);
}

try {
  const provider = createLarkCliDocumentProvider({
    appId: 'cli_test_app_id',
    appSecret: 'cli_test_app_secret',
    brand: 'feishu',
    sourceRouteId: 'research-bot',
    configDir: join(tempRoot, 'profiles', 'research-bot'),
    snapshotDir: join(tempRoot, 'snapshots', 'research-bot'),
    larkCliPath: '/managed/remotelab/node_modules/.bin/lark-cli',
    runCommand,
  });

  const result = await provider.fetch({
    documentToken: 'https://example.feishu.cn/docx/DOCtoken123456789',
    scope: 'section',
    startBlockId: 'headingA',
    detail: 'with-ids',
    docFormat: 'xml',
    maxChars: 12,
    downloadMedia: true,
  });

  assert.equal(result.documentToken, 'DOCtoken123456789');
  assert.equal(result.title, '表征实验');
  assert.equal(result.revisionId, 42);
  assert.equal(result.identity, 'bot');
  assert.equal(result.scope, 'section');
  assert.equal(result.detail, 'with-ids');
  assert.equal(result.docFormat, 'xml');
  assert.equal(result.content.length, 12);
  assert.equal(result.truncated, true);
  assert.ok(result.contentLength > result.content.length);
  assert.equal(result.media.length, 2);
  assert.equal(result.media[0].type, 'image');
  assert.match(result.media[0].localPath, /\.jpg$/);
  assert.equal(result.media[1].type, 'whiteboard');
  assert.match(result.media[1].localPath, /\.png$/);

  const fullContent = await readFile(result.contentPath, 'utf8');
  assert.match(fullContent, /第一段第二段第三段/);
  const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
  assert.equal(manifest.sourceRouteId, 'research-bot');
  assert.equal(manifest.documentToken, 'DOCtoken123456789');
  assert.equal(manifest.media.length, 2);

  assert.equal(calls[0].args[0], 'config');
  assert.deepEqual(calls[0].args.slice(0, 4), ['config', 'init', '--app-id', 'cli_test_app_id']);
  assert.equal(calls[0].stdin, 'cli_test_app_secret\n');
  assert.equal(calls[0].env.LARKSUITE_CLI_CONFIG_DIR, join(tempRoot, 'profiles', 'research-bot'));
  assert.equal(calls[0].env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER, '1');
  assert.equal(calls[0].env.LARKSUITE_CLI_NO_SKILLS_NOTIFIER, '1');
  assert.equal(calls[0].env.OPENCLAW_HOME, undefined);
  assert.equal(calls[0].env.LARK_CHANNEL_CONFIG, undefined);

  const fetchCall = calls.find((call) => call.args[1] === '+fetch');
  assert.ok(fetchCall);
  assert.ok(fetchCall.args.includes('--as'));
  assert.equal(fetchCall.args[fetchCall.args.indexOf('--as') + 1], 'bot');
  assert.equal(fetchCall.args[fetchCall.args.indexOf('--scope') + 1], 'section');
  assert.equal(fetchCall.args[fetchCall.args.indexOf('--start-block-id') + 1], 'headingA');
  assert.equal(fetchCall.args[fetchCall.args.indexOf('--detail') + 1], 'with-ids');
  assert.ok(!fetchCall.args.includes('--yes'));

  const mediaCalls = calls.filter((call) => call.args[1] === '+media-download');
  assert.equal(mediaCalls.length, 2);
  assert.deepEqual(mediaCalls.map((call) => call.args[call.args.indexOf('--type') + 1]), ['media', 'whiteboard']);

  await provider.fetch({
    documentToken: 'DOCtoken123456789',
    scope: 'outline',
    maxDepth: 3,
  });
  assert.equal(calls.filter((call) => call.args[0] === 'config').length, 1, 'provider should initialize one isolated profile once');

  await provider.fetch({
    documentToken: 'DOCtoken123456789',
    scope: 'range',
    startBlockId: 'headingA',
    endBlockId: -1,
  });
  const rangeCall = calls.filter((call) => call.args[1] === '+fetch').at(-1);
  assert.equal(rangeCall.args[rangeCall.args.indexOf('--end-block-id') + 1], '-1');

  const wikiUrl = 'https://example.feishu.cn/wiki/WIKItoken123456789';
  const wikiResult = await provider.fetch({ documentToken: wikiUrl, scope: 'outline' });
  assert.equal(wikiResult.documentToken, 'WIKItoken123456789');
  const wikiCall = calls.filter((call) => call.args[1] === '+fetch').at(-1);
  assert.equal(wikiCall.args[wikiCall.args.indexOf('--doc') + 1], wikiUrl);

  await assert.rejects(
    () => provider.fetch({ documentToken: 'DOCtoken123456789', scope: 'section' }),
    (error) => error?.code === 'document_parameters_invalid' && error?.statusCode === 400,
  );
  await assert.rejects(
    () => provider.fetch({ documentToken: 'DOCtoken123456789', scope: 'keyword' }),
    (error) => error?.code === 'document_parameters_invalid' && error?.statusCode === 400,
  );

  const secondBotCalls = [];
  const secondBot = createLarkCliDocumentProvider({
    appId: 'cli_second_app_id',
    appSecret: 'cli_second_app_secret',
    brand: 'lark',
    sourceRouteId: 'sales-bot',
    configDir: join(tempRoot, 'profiles', 'sales-bot'),
    snapshotDir: join(tempRoot, 'snapshots', 'sales-bot'),
    runCommand: async (request) => {
      secondBotCalls.push(request);
      return await runCommand(request);
    },
  });
  await secondBot.fetch({ documentToken: 'DOCtoken123456789', scope: 'outline' });
  assert.equal(secondBotCalls[0].stdin, 'cli_second_app_secret\n');
  assert.equal(secondBotCalls[0].env.LARKSUITE_CLI_CONFIG_DIR, join(tempRoot, 'profiles', 'sales-bot'));
  assert.notEqual(secondBotCalls[0].env.LARKSUITE_CLI_CONFIG_DIR, calls[0].env.LARKSUITE_CLI_CONFIG_DIR);

  const deniedProvider = createLarkCliDocumentProvider({
    appId: 'cli_denied_app_id',
    appSecret: 'cli_denied_app_secret',
    sourceRouteId: 'denied-bot',
    configDir: join(tempRoot, 'profiles', 'denied-bot'),
    snapshotDir: join(tempRoot, 'snapshots', 'denied-bot'),
    runCommand: async (request) => {
      if (request.args[0] === 'config') return { stdout: '', stderr: '' };
      const error = new Error('lark-cli failed');
      error.code = 1;
      error.stderr = JSON.stringify({
        ok: false,
        error: {
          type: 'permission_denied',
          message: 'missing scope',
          permission_violations: [{ scope: 'docx:document:readonly' }],
          console_url: 'https://open.feishu.cn/app/test/permission',
        },
      });
      throw error;
    },
  });
  await assert.rejects(
    () => deniedProvider.fetch({ documentToken: 'DOCtoken123456789' }),
    (error) => (
      error?.code === 'missing_scope'
      && error?.statusCode === 403
      && error?.details?.consoleUrl === 'https://open.feishu.cn/app/test/permission'
    ),
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

console.log('test-feishu-lark-cli-document-provider: ok');
