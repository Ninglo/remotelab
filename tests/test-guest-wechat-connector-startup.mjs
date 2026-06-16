#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const moduleUrl = pathToFileURL(join(repoRoot, 'lib', 'guest-wechat-connector-startup.mjs')).href;
const { ensureGuestWeChatConnectorStartup } = await import(moduleUrl);

async function main() {
  const configDir = await mkdtemp(join(tmpdir(), 'remotelab-guest-wechat-startup-'));

  try {
    const skipped = await ensureGuestWeChatConnectorStartup({
      isGuestInstance: false,
      configDir,
    });
    assert.equal(skipped.attempted, false);
    assert.equal(skipped.reason, 'not_guest_instance');

    let execCalled = false;
    const missingConfig = await ensureGuestWeChatConnectorStartup({
      isGuestInstance: true,
      instanceRoot: '/var/lib/remotelab-guests/trial66',
      configDir,
      execFileImpl: async () => {
        execCalled = true;
        return { stdout: '', stderr: '' };
      },
    });
    assert.equal(missingConfig.attempted, false);
    assert.equal(missingConfig.reason, 'wechat_not_configured');
    assert.equal(execCalled, false);

    const connectorDir = join(configDir, 'wechat-connector');
    await mkdir(connectorDir, { recursive: true });
    await writeFile(join(connectorDir, 'config.json'), JSON.stringify({
      chatBaseUrl: 'http://127.0.0.1:7786',
      sourceName: 'WeChat',
      group: 'WeChat',
    }, null, 2), 'utf8');

    const unbound = await ensureGuestWeChatConnectorStartup({
      isGuestInstance: true,
      instanceRoot: '/var/lib/remotelab-guests/trial66',
      configDir,
      execFileImpl: async () => {
        execCalled = true;
        return { stdout: '', stderr: '' };
      },
    });
    assert.equal(unbound.attempted, false);
    assert.equal(unbound.reason, 'wechat_not_bound');
    assert.equal(execCalled, false);

    await writeFile(join(connectorDir, 'accounts.json'), JSON.stringify([
      { accountId: 'wx-1' },
    ], null, 2), 'utf8');

    const invocations = [];
    const ensured = await ensureGuestWeChatConnectorStartup({
      isGuestInstance: true,
      instanceRoot: '/var/lib/remotelab-guests/trial66',
      configDir,
      chatPort: 7786,
      publicBaseUrl: 'https://trial66.example.com',
      scriptPath: '/tmp/wechat-connector-instance.sh',
      projectRoot: '/opt/remotelab',
      execFileImpl: async (command, args, options) => {
        invocations.push({ command, args, options });
        return {
          stdout: 'started wechat connector (pid 123)\n',
          stderr: '',
        };
      },
    });

    assert.equal(ensured.attempted, true);
    assert.equal(ensured.reason, 'ensured');
    assert.match(ensured.stdout, /started wechat connector/i);
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].command, '/tmp/wechat-connector-instance.sh');
    assert.deepEqual(invocations[0].args, ['start']);
    assert.equal(invocations[0].options.cwd, '/opt/remotelab');
    assert.equal(invocations[0].options.env.REMOTELAB_INSTANCE_ROOT, '/var/lib/remotelab-guests/trial66');
    assert.equal(invocations[0].options.env.CHAT_PORT, '7786');
    assert.equal(invocations[0].options.env.REMOTELAB_PUBLIC_BASE_URL, 'https://trial66.example.com');

    console.log('ok - guest startup ensure only starts configured wechat connectors');
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
}

await main();
