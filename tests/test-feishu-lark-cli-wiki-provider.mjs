#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLarkCliDocumentProvider } from '../connectors/feishu/lark-cli-document-provider.mjs';

const tempRoot = await mkdtemp(join(tmpdir(), 'remotelab-feishu-lark-cli-wiki-provider-'));
const calls = [];

function argumentValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : '';
}

function node(overrides = {}) {
  return {
    space_id: 'space-1',
    node_token: 'wikcnRoot123',
    obj_token: 'docxRoot123',
    obj_type: 'docx',
    node_type: 'origin',
    parent_node_token: '',
    title: 'Root',
    has_child: false,
    ...overrides,
  };
}

async function runCommand(request) {
  calls.push(request);
  if (request.args[0] === 'config') {
    return { stdout: JSON.stringify({ ok: true }), stderr: '' };
  }
  if (request.args[0] === 'wiki' && request.args[1] === '+node-get') {
    return {
      stdout: JSON.stringify({
        ok: true,
        identity: 'bot',
        data: { node: node({ has_child: true }) },
      }),
      stderr: '',
    };
  }
  if (request.args[0] === 'wiki' && request.args[1] === '+node-list') {
    const parent = argumentValue(request.args, '--parent-node-token');
    const pageToken = argumentValue(request.args, '--page-token');
    const pageSize = Number(argumentValue(request.args, '--page-size'));
    if (parent === 'wikcnDenied123') {
      const error = new Error('lark-cli failed');
      error.code = 1;
      error.stderr = JSON.stringify({
        ok: false,
        error: {
          type: 'permission_denied',
          message: 'forbidden branch',
          console_url: 'https://open.feishu.cn/app/test/permission',
        },
      });
      throw error;
    }
    if (parent === 'wikcnAllowed123') {
      return {
        stdout: JSON.stringify({
          ok: true,
          identity: 'bot',
          data: {
            nodes: [node({
              node_token: 'wikcnAllowedLeaf123',
              obj_token: 'docxAllowedLeaf123',
              parent_node_token: parent,
              title: 'Allowed leaf',
            })],
            has_more: false,
            page_token: '',
          },
        }),
        stderr: '',
      };
    }

    const allRootNodes = [
      node({ node_token: 'wikcnAllowed123', obj_token: 'docxAllowed123', title: 'Allowed', has_child: true }),
      node({ node_token: 'wikcnDenied123', obj_token: 'docxDenied123', title: 'Denied', has_child: true }),
      node({ node_token: 'wikcnTail123', obj_token: 'docxTail123', title: 'Tail' }),
    ];
    const start = pageToken === 'root-page-2' ? 2 : 0;
    const nodes = allRootNodes.slice(start, start + pageSize);
    const nextIndex = start + nodes.length;
    return {
      stdout: JSON.stringify({
        ok: true,
        identity: 'bot',
        data: {
          nodes,
          has_more: nextIndex < allRootNodes.length,
          page_token: nextIndex < allRootNodes.length ? 'root-page-2' : '',
        },
      }),
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
    sourceRouteId: 'wiki-bot',
    configDir: join(tempRoot, 'profile'),
    snapshotDir: join(tempRoot, 'snapshots'),
    larkCliPath: '/managed/remotelab/node_modules/.bin/lark-cli',
    runCommand,
  });

  const wikiNode = await provider.getWikiNode({
    nodeToken: 'https://example.feishu.cn/wiki/wikcnRoot123',
    spaceId: 'space-1',
  });
  assert.deepEqual(wikiNode, {
    identity: 'bot',
    node: {
      spaceId: 'space-1',
      nodeToken: 'wikcnRoot123',
      objToken: 'docxRoot123',
      objType: 'docx',
      nodeType: 'origin',
      parentNodeToken: '',
      title: 'Root',
      hasChild: true,
    },
  });
  const nodeGetCall = calls.find((call) => call.args[1] === '+node-get');
  assert.deepEqual(nodeGetCall.args.slice(0, 2), ['wiki', '+node-get']);
  assert.equal(argumentValue(nodeGetCall.args, '--node-token'), 'https://example.feishu.cn/wiki/wikcnRoot123');
  assert.equal(argumentValue(nodeGetCall.args, '--space-id'), 'space-1');
  assert.equal(argumentValue(nodeGetCall.args, '--as'), 'bot');

  const children = await provider.listWikiChildren({
    spaceId: 'space-1',
    pageSize: 2,
    pageToken: 'root-page-2',
  });
  assert.equal(children.nodes.length, 1);
  assert.equal(children.nodes[0].nodeToken, 'wikcnTail123');
  assert.equal(children.hasMore, false);
  assert.equal(children.nextPageToken, '');
  const childrenCall = calls.filter((call) => call.args[1] === '+node-list').at(-1);
  assert.equal(argumentValue(childrenCall.args, '--page-size'), '2');
  assert.equal(argumentValue(childrenCall.args, '--page-token'), 'root-page-2');
  assert.ok(!childrenCall.args.includes('--page-all'));

  await assert.rejects(
    () => provider.getWikiNode({ nodeToken: 'short' }),
    (error) => error?.code === 'wiki_node_token_invalid' && error?.statusCode === 400,
  );
  await assert.rejects(
    () => provider.getWikiNode({ nodeToken: 'docxRawToken123' }),
    (error) => error?.code === 'wiki_parameters_invalid' && error?.statusCode === 400,
  );
  await assert.rejects(
    () => provider.getWikiNode({ nodeToken: 'wikcnRoot123', objType: 'docx' }),
    (error) => error?.code === 'wiki_parameters_invalid' && error?.statusCode === 400,
  );
  await assert.rejects(
    () => provider.listWikiChildren({ spaceId: 'space-1', pageSize: 51 }),
    (error) => error?.code === 'wiki_parameters_invalid' && error?.statusCode === 400,
  );
  await assert.rejects(
    () => provider.listWikiChildren({ spaceId: 'my_library' }),
    (error) => error?.code === 'wiki_parameters_invalid' && error?.statusCode === 400,
  );

  const depthLimited = await provider.listWikiTree({
    spaceId: 'space-1',
    maxDepth: 0,
    maxNodes: 20,
    maxPages: 20,
    pageSize: 3,
  });
  assert.equal(depthLimited.complete, false);
  assert.equal(depthLimited.truncated, true);
  assert.equal(depthLimited.stop_reason, 'max_depth');
  assert.equal(depthLimited.visited, 3);
  assert.equal(depthLimited.returned, 3);
  assert.equal(depthLimited.failed, 0);
  assert.equal(depthLimited.continuation.can_resume, true);
  assert.ok(depthLimited.continuation.token);

  const nodeLimited = await provider.listWikiTree({
    spaceId: 'space-1',
    maxDepth: 3,
    maxNodes: 2,
    maxPages: 20,
    pageSize: 50,
  });
  assert.equal(nodeLimited.stop_reason, 'max_nodes');
  assert.equal(nodeLimited.returned, 2);
  assert.equal(nodeLimited.continuation.can_resume, true);
  const nodeLimitedCall = calls.filter((call) => call.args[1] === '+node-list').at(-1);
  assert.equal(argumentValue(nodeLimitedCall.args, '--page-size'), '2', 'tree traversal should not over-fetch beyond maxNodes');

  const pageLimited = await provider.listWikiTree({
    spaceId: 'space-1',
    maxDepth: 3,
    maxNodes: 20,
    maxPages: 1,
    pageSize: 1,
  });
  assert.equal(pageLimited.stop_reason, 'max_pages');
  assert.equal(pageLimited.pagesVisited, 1);
  assert.equal(pageLimited.continuation.can_resume, true);

  const resumed = await provider.listWikiTree({
    spaceId: 'space-1',
    continuationToken: nodeLimited.continuation.token,
    maxDepth: 3,
    maxNodes: 20,
    maxPages: 20,
    pageSize: 2,
  });
  assert.ok(resumed.returned >= 1, 'continuation should resume pending BFS work');

  const partial = await provider.listWikiTree({
    spaceId: 'space-1',
    maxDepth: 3,
    maxNodes: 20,
    maxPages: 20,
    pageSize: 3,
    maxInlineNodes: 1,
  });
  assert.equal(partial.complete, false);
  assert.equal(partial.truncated, true);
  assert.equal(partial.stop_reason, 'permission_failures');
  assert.equal(partial.failed, 1);
  assert.equal(partial.permission_failures.count, 1);
  assert.equal(partial.permission_failures.items[0].code, 'wiki_permission_denied');
  assert.equal(partial.permission_failures.items[0].parentNodeToken, 'wikcnDenied123');
  assert.equal(partial.inline_truncated, true);
  assert.equal(partial.nodes.length, 1);
  assert.ok(partial.contentPath);
  const snapshot = JSON.parse(await readFile(partial.contentPath, 'utf8'));
  assert.equal(snapshot.nodes.length, partial.returned);
  assert.equal(snapshot.permission_failures.count, 1);
  assert.equal(partial.continuation.can_resume, true, 'failed branches should be retryable after permissions change');

  const deniedCall = calls.find((call) => argumentValue(call.args, '--parent-node-token') === 'wikcnDenied123');
  assert.ok(deniedCall, 'BFS should visit the denied child branch while continuing other branches');
  const allowedCall = calls.find((call) => argumentValue(call.args, '--parent-node-token') === 'wikcnAllowed123');
  assert.ok(allowedCall, 'BFS should continue after a sibling permission failure');

  const missingScopeProvider = createLarkCliDocumentProvider({
    appId: 'cli_missing_scope_app_id',
    appSecret: 'cli_missing_scope_app_secret',
    sourceRouteId: 'missing-scope-bot',
    configDir: join(tempRoot, 'missing-scope-profile'),
    snapshotDir: join(tempRoot, 'missing-scope-snapshots'),
    runCommand: async (request) => {
      if (request.args[0] === 'config') return { stdout: '', stderr: '' };
      const error = new Error('lark-cli failed');
      error.code = 1;
      error.stderr = JSON.stringify({
        ok: false,
        error: {
          type: 'missing_scope',
          message: 'wiki:node:retrieve scope required',
          console_url: 'https://open.feishu.cn/app/test/wiki-permission',
        },
      });
      throw error;
    },
  });
  await assert.rejects(
    () => missingScopeProvider.listWikiChildren({ spaceId: 'space-1' }),
    (error) => (
      error?.code === 'missing_scope'
      && error?.statusCode === 403
      && /Wiki node read scope/.test(error?.message)
      && error?.details?.consoleUrl === 'https://open.feishu.cn/app/test/wiki-permission'
    ),
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

console.log('test-feishu-lark-cli-wiki-provider: ok');
