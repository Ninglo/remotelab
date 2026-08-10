#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoot = await mkdtemp(join(tmpdir(), 'remotelab-feishu-wiki-skill-'));
process.env.HOME = tempRoot;
process.env.REMOTELAB_CONFIG_DIR = join(tempRoot, 'config');
process.env.REMOTELAB_MEMORY_DIR = join(tempRoot, 'memory');
process.env.REMOTELAB_WORK_ROOT_DIR = join(tempRoot, 'workspace');

const { FEISHU_SKILLS } = await import('../connectors/feishu/index.mjs');
const {
  getFeishuWikiNode,
  listFeishuWikiChildren,
  listFeishuWikiTree,
} = await import('../connectors/feishu/wiki-skill.mjs');
const { startFeishuDocumentCapability } = await import('../connectors/feishu/document-skill.mjs');
const { initSkillRegistry } = await import('../lib/connector-skill-registry.mjs');
const { runConnectorCommand } = await import('../lib/connector-command.mjs');
const { buildSystemContext } = await import('../chat/system-prompt.mjs');

for (const name of ['wiki_node_get', 'wiki_children_list', 'wiki_tree_list']) {
  assert.ok(FEISHU_SKILLS.some((skill) => skill.name === name), `Feishu should declare ${name}`);
}
const nodeSkill = FEISHU_SKILLS.find((skill) => skill.name === 'wiki_node_get');
assert.equal(nodeSkill.schema.nodeToken.required, true);
const childrenSkill = FEISHU_SKILLS.find((skill) => skill.name === 'wiki_children_list');
assert.equal(childrenSkill.schema.spaceId.required, true);
assert.equal(childrenSkill.schema.pageSize.type, 'number');
assert.equal(childrenSkill.schema.pageToken.type, 'string');
const treeSkill = FEISHU_SKILLS.find((skill) => skill.name === 'wiki_tree_list');
assert.equal(treeSkill.schema.maxDepth.type, 'number');
assert.equal(treeSkill.schema.maxNodes.type, 'number');
assert.equal(treeSkill.schema.maxPages.type, 'number');
assert.equal(treeSkill.schema.continuationToken.type, 'string');

const calls = [];
let initializations = 0;
const provider = {
  async initialize() { initializations += 1; },
  async fetch() { throw new Error('document fetch is not expected'); },
  async getWikiNode(parameters) {
    calls.push(['node', parameters]);
    return { identity: 'bot', node: { nodeToken: parameters.nodeToken, title: 'Node' } };
  },
  async listWikiChildren(parameters) {
    calls.push(['children', parameters]);
    return { identity: 'bot', nodes: [], hasMore: false, nextPageToken: '' };
  },
  async listWikiTree(parameters) {
    calls.push(['tree', parameters]);
    return {
      identity: 'bot',
      complete: true,
      truncated: false,
      stop_reason: 'completed',
      visited: 0,
      returned: 0,
      failed: 0,
      nodes: [],
      permission_failures: { count: 0, items: [] },
      continuation: { can_resume: false, token: '' },
    };
  },
};
const runtime = {
  config: {
    appId: 'test-app-id',
    appSecret: 'test-app-secret',
    region: 'feishu-cn',
    sourceRouteId: 'default',
    storageDir: tempRoot,
  },
  documentProvider: provider,
};

assert.equal((await getFeishuWikiNode(runtime, { nodeToken: 'wikcnRoot123' })).node.title, 'Node');
await listFeishuWikiChildren(runtime, { spaceId: 'space-1', pageSize: 25 });
await listFeishuWikiTree(runtime, { spaceId: 'space-1', maxDepth: 2 });
assert.deepEqual(calls.map(([name]) => name), ['node', 'children', 'tree']);

await assert.rejects(
  () => getFeishuWikiNode(runtime, { nodeToken: '' }),
  (error) => error?.code === 'wiki_node_token_invalid' && error?.statusCode === 400,
);
await assert.rejects(
  () => listFeishuWikiChildren({ documentProvider: {} }, { spaceId: 'space-1' }),
  (error) => error?.code === 'connector_unavailable' && error?.statusCode === 503,
);
await assert.rejects(
  () => listFeishuWikiTree({
    documentProvider: {
      async listWikiTree() {
        const error = new Error('forbidden');
        error.code = 'wiki_permission_denied';
        error.statusCode = 403;
        throw error;
      },
    },
  }, { spaceId: 'space-1' }),
  (error) => error?.code === 'wiki_permission_denied' && error?.statusCode === 403,
);

await initSkillRegistry(process.env.REMOTELAB_CONFIG_DIR);
const capability = await startFeishuDocumentCapability(runtime, {
  configDir: process.env.REMOTELAB_CONFIG_DIR,
  documentProvider: provider,
});

try {
  assert.equal(initializations, 1);
  let stdout = '';
  const exitCode = await runConnectorCommand([
    'call',
    'feishu:wiki_children_list',
    '--space-id', 'space-1',
    '--parent-node-token', 'wikcnRoot123',
    '--page-size', '25',
    '--page-token', 'cursor-1',
    '--json',
  ], {
    stdout: { write(chunk) { stdout += String(chunk); } },
  });
  assert.equal(exitCode, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.success, true);
  assert.deepEqual(calls.at(-1), ['children', {
    spaceId: 'space-1',
    parentNodeToken: 'wikcnRoot123',
    pageSize: 25,
    pageToken: 'cursor-1',
  }]);

  const systemContext = await buildSystemContext({ sessionId: 'session-feishu-wiki-test' });
  assert.match(systemContext, /### Feishu Wiki/);
  assert.match(systemContext, /feishu:wiki_node_get/);
  assert.match(systemContext, /feishu:wiki_children_list/);
  assert.match(systemContext, /feishu:wiki_tree_list/);
  assert.match(systemContext, /complete.*truncated.*stop_reason/s);
  assert.match(systemContext, /continuation/);
  assert.match(systemContext, /does not fetch document bodies/i);
} finally {
  await capability.stop();
  await rm(tempRoot, { recursive: true, force: true });
}

console.log('test-feishu-wiki-skill: ok');
