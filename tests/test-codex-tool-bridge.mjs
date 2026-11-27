#!/usr/bin/env node
import assert from 'node:assert/strict';

import { createCodexToolBridge, CODEX_TOOL_DEFINITIONS } from '../chat/codex-tool-bridge.mjs';
import { buildCodexToolBridgeOverrides, buildClaudeToolBridgeConfig } from '../chat/codex-tool-bridge-config.mjs';
import { createCodexDriver } from '../chat/native/codex.mjs';

const calls = [];
const responses = [];
const bridge = createCodexToolBridge({
  runCommand: async (argv, { stdout }) => {
    calls.push(argv);
    stdout.write(JSON.stringify({ ok: true, argv }));
    return 0;
  },
  write: (message) => responses.push(message),
});

await bridge.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
assert.equal(responses[0].result.protocolVersion, '2025-06-18');
await bridge.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
const listed = responses[1].result.tools.map((tool) => tool.name);
assert.deepEqual(listed, CODEX_TOOL_DEFINITIONS.map((tool) => tool.name));
assert(!listed.some((name) => /pair|bootstrap|robot|command/i.test(name)));

await bridge.handle({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: { name: 'remotelab_local_bridge_read_text', arguments: {
    rootAlias: 'robot', relPath: 'logs/run.txt', offset: 12, maxBytes: 4096,
  } },
});
assert.deepEqual(calls[0], ['read-text', '--root', 'robot', '--path', 'logs/run.txt', '--offset', '12', '--max-bytes', '4096', '--json']);
assert.equal(responses[2].result.isError, undefined);

await bridge.handle({
  jsonrpc: '2.0',
  id: 4,
  method: 'tools/call',
  params: { name: 'remotelab_local_bridge_stage', arguments: {
    rootAlias: 'robot', relPath: 'logs/run.txt', purpose: 'inspect', sizeBytes: 100,
  } },
});
assert.deepEqual(calls[1], ['stage', '--root', 'robot', '--path', 'logs/run.txt', '--purpose', 'inspect', '--size-bytes', '100', '--json']);

await bridge.handle({
  jsonrpc: '2.0',
  id: 5,
  method: 'tools/call',
  params: { name: 'remotelab_local_bridge_read_text', arguments: {
    rootAlias: 'robot', relPath: 'logs/run.txt', sessionId: 'other-session',
  } },
});
assert.equal(responses[4].result.isError, true);
assert.match(responses[4].result.content[0].text, /Unknown tool argument: sessionId/);

await bridge.handle({
  jsonrpc: '2.0',
  id: 6,
  method: 'tools/call',
  params: { name: 'remotelab_progress', arguments: { text: 'A useful progress update' } },
});
assert.deepEqual(JSON.parse(responses[5].result.content[0].text), { ok: true });
assert.equal(calls.length, 2, 'progress tool must not invoke the local bridge command');

const driver = createCodexDriver({ send() {}, options: {} });
const overrides = buildCodexToolBridgeOverrides();
for (const override of overrides) assert(driver.args.includes(override.split('=', 1)[0] + '=' + override.slice(override.indexOf('=') + 1)) || driver.args.includes(override));
assert(driver.args.some((arg) => arg.includes('mcp_servers.remotelab.command=')));
assert(driver.args.some((arg) => arg.includes('mcp_servers.remotelab.args=')));
const claudeConfig = JSON.parse(buildClaudeToolBridgeConfig({ nodePath: '/node', scriptPath: '/bridge.mjs' }));
assert.deepEqual(claudeConfig.mcpServers.remotelab, { command: '/node', args: ['/bridge.mjs'] });

console.log('test-codex-tool-bridge: ok');
