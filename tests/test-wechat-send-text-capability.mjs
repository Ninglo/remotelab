#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoot = await mkdtemp(join(tmpdir(), 'remotelab-wechat-send-text-'));
process.env.HOME = tempRoot;
process.env.REMOTELAB_CONFIG_DIR = join(tempRoot, 'config');
process.env.REMOTELAB_MEMORY_DIR = join(tempRoot, 'memory');
process.env.REMOTELAB_WORK_ROOT_DIR = join(tempRoot, 'workspace');

const {
  definition,
  WECHAT_SKILLS,
  createWeChatCapabilityController,
  invokeWeChatSendText,
} = await import('../connectors/wechat/index.mjs');
const { runConnectorCommand } = await import('../lib/connector-command.mjs');
const { buildSystemContext } = await import('../chat/system-prompt.mjs');

assert.equal(definition.id, 'wechat');
assert.equal(definition.hostStrategies[0].kind, 'local');
assert.equal(definition.bindingSchema.cardinality, 'one_bot_per_wechat_user');
assert.equal(definition.actions[0].toolName, 'wechat:send_text');
assert.equal(WECHAT_SKILLS.length, 1);
assert.equal(WECHAT_SKILLS[0].name, 'send_text');
assert.equal(WECHAT_SKILLS[0].schema.text.required, true);
assert.equal(WECHAT_SKILLS[0].schema.sessionId.required, undefined);

await assert.rejects(
  () => invokeWeChatSendText({ text: '   ' }, { sendText: async () => ({}) }),
  (error) => error?.code === 'text_required' && error?.statusCode === 400,
);

const deliveries = [];
const controller = createWeChatCapabilityController({}, {
  configDir: process.env.REMOTELAB_CONFIG_DIR,
  sendText: async ({ text, sessionId }) => {
    deliveries.push({ text, sessionId });
    return {
      message_id: `wechat-message-${deliveries.length}`,
      accountId: 'bound-account-secret-id',
      peerUserId: 'bound-user-secret-id',
      sessionId,
    };
  },
});

try {
  const ready = await controller.reconcile([{ accountId: 'bound-account-secret-id' }]);
  assert.equal(ready.ready, true);
  assert.equal(ready.changed, true);
  assert.match(ready.skillUrl, /^http:\/\/127\.0\.0\.1:\d+\/skill$/);

  let stdout = '';
  const exitCode = await runConnectorCommand([
    'call',
    'wechat:send_text',
    '--text', '今日资源日报',
    '--json',
  ], {
    stdout: { write(chunk) { stdout += String(chunk); } },
  });
  assert.equal(exitCode, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.success, true);
  assert.equal(result.result.connectorId, 'wechat');
  assert.equal(result.result.deliveryState, 'delivered');
  assert.equal(result.result.externalId, 'wechat-message-1');
  assert.match(result.result.bindingId, /^wechat_binding_[a-f0-9]{16}$/);
  assert.match(result.result.targetId, /^wechat_target_[a-f0-9]{16}$/);
  assert.equal(JSON.stringify(result).includes('bound-account-secret-id'), false);
  assert.equal(JSON.stringify(result).includes('bound-user-secret-id'), false);
  assert.deepEqual(deliveries, [{ text: '今日资源日报', sessionId: '' }]);

  const context = await buildSystemContext({ sessionId: 'session-wechat-action-test' });
  assert.match(context, /### Connector Actions/);
  assert.match(context, /wechat:send_text/);
  assert.match(context, /--text "<text>"/);
  assert.match(context, /deterministic external delivery/);

  const stopped = await controller.reconcile([]);
  assert.equal(stopped.ready, false);
  assert.equal(stopped.changed, true);

  stdout = '';
  const listExitCode = await runConnectorCommand(['list', '--json'], {
    stdout: { write(chunk) { stdout += String(chunk); } },
  });
  assert.equal(listExitCode, 0);
  assert.equal(JSON.parse(stdout).tools.some((tool) => tool.name === 'wechat:send_text'), false);
} finally {
  await controller.stop();
  await rm(tempRoot, { recursive: true, force: true });
}

console.log('test-wechat-send-text-capability: ok');
