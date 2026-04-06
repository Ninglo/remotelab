#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { findMailboxRuntimeByName, loadMailboxRuntimeRegistry } from '../lib/mailbox-runtime-registry.mjs';

const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-mailbox-runtime-registry-'));

try {
  const cloudflaredDir = join(tempHome, '.cloudflared');
  const launchAgentsDir = join(tempHome, 'Library', 'LaunchAgents');
  const configDir = join(tempHome, '.config', 'remotelab');
  const instancesRoot = join(tempHome, '.remotelab', 'instances');

  mkdirSync(cloudflaredDir, { recursive: true });
  mkdirSync(launchAgentsDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(instancesRoot, { recursive: true });

  writeFileSync(join(cloudflaredDir, 'config.yml'), [
    'tunnel: example-tunnel',
    'credentials-file: /tmp/example.json',
    'protocol: http2',
    '',
    'ingress:',
    '  - hostname: trial.example.com',
    '    service: http://127.0.0.1:7696',
    '  - service: http_status:404',
    '',
  ].join('\n'));

  const trialInstanceRoot = join(instancesRoot, 'trial');
  mkdirSync(join(trialInstanceRoot, 'config'), { recursive: true });
  mkdirSync(join(trialInstanceRoot, 'memory'), { recursive: true });
  writeFileSync(join(trialInstanceRoot, 'config', 'auth.json'), JSON.stringify({ token: 'trial-auth-token' }, null, 2));

  writeFileSync(join(launchAgentsDir, 'com.chatserver.trial.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.chatserver.trial</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>CHAT_PORT</key>
      <string>7696</string>
      <key>REMOTELAB_INSTANCE_ROOT</key>
      <string>${trialInstanceRoot}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${join(tempHome, 'Library', 'Logs', 'chat-server-trial.log')}</string>
    <key>StandardErrorPath</key>
    <string>${join(tempHome, 'Library', 'Logs', 'chat-server-trial.error.log')}</string>
  </dict>
</plist>
`);

  writeFileSync(join(configDir, 'guest-instances.json'), JSON.stringify([
    {
      name: 'intake1',
      localBaseUrl: 'http://127.0.0.1:7703',
      publicBaseUrl: 'https://intake1.example.com',
      authFile: join(tempHome, '.remotelab', 'instances', 'intake1', 'config', 'auth.json'),
    },
  ], null, 2));

  const registry = await loadMailboxRuntimeRegistry({ homeDir: tempHome });
  assert.equal(registry.length, 2);

  const trial = findMailboxRuntimeByName('trial', registry);
  assert.ok(trial);
  assert.equal(trial.name, 'trial');
  assert.equal(trial.localBaseUrl, 'http://127.0.0.1:7696');
  assert.equal(trial.publicBaseUrl, 'https://trial.example.com');
  assert.equal(trial.authFile, join(trialInstanceRoot, 'config', 'auth.json'));
  assert.deepEqual(trial.mailboxNames, ['trial', 'trial1']);

  const trial1 = findMailboxRuntimeByName('trial1', registry);
  assert.ok(trial1);
  assert.equal(trial1.name, 'trial');

  const intake1 = findMailboxRuntimeByName('intake1', registry);
  assert.ok(intake1);
  assert.equal(intake1.name, 'intake1');
  assert.deepEqual(intake1.mailboxNames, ['intake1']);

  console.log('mailbox runtime registry tests passed');
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}
