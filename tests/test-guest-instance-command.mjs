#!/usr/bin/env node
import assert from 'assert/strict';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import {
  buildGuestMailboxAddress,
  formatGuestInstance,
} from '../lib/guest-instance-command.mjs';
import {
  buildLaunchAgentPlist,
  deriveDomainFromHostname,
  deriveGuestHostname,
  parseTunnelName,
  pickNextGuestPort,
  sanitizeGuestInstanceName,
  selectPrimaryHostnameForPort,
  upsertCloudflaredIngress,
} from '../lib/guest-instance.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const baseConfig = `tunnel: claude-code-remote
credentials-file: /Users/example/.cloudflared/example-tunnel.json
protocol: http2

ingress:
  - hostname: remotelab.example.com
    service: http://127.0.0.1:7690
  - hostname: companion.example.com
    service: http://127.0.0.1:7692
  - service: http_status:404
`;

assert.equal(sanitizeGuestInstanceName(' Trial 4 '), 'trial-4');
assert.equal(sanitizeGuestInstanceName('试用 用户'), '');
assert.equal(
  buildGuestMailboxAddress('trial16', { localPart: 'rowan', domain: 'jiujianian.dev' }),
  'rowan+trial16@jiujianian.dev',
);
assert.equal(
  buildGuestMailboxAddress('trial16', { localPart: 'rowan', domain: 'jiujianian.dev', instanceAddressMode: 'local_part' }),
  'trial16@jiujianian.dev',
);
assert.equal(
  buildGuestMailboxAddress(' Trial 16 ', { localPart: 'rowan', domain: 'jiujianian.dev' }),
  'rowan+trial-16@jiujianian.dev',
);
assert.equal(
  buildGuestMailboxAddress(' Trial 16 ', { localPart: 'rowan', domain: 'jiujianian.dev', instanceAddressMode: 'local_part' }),
  'trial-16@jiujianian.dev',
);
assert.equal(buildGuestMailboxAddress('试用 用户', { localPart: 'rowan', domain: 'jiujianian.dev' }), '');

assert.equal(parseTunnelName(baseConfig), 'claude-code-remote');
assert.equal(selectPrimaryHostnameForPort(baseConfig, { port: 7690 }), 'remotelab.example.com');
assert.equal(deriveDomainFromHostname('remotelab.example.com'), 'example.com');
assert.equal(
  deriveGuestHostname(baseConfig, { name: 'trial4' }),
  'trial4.example.com',
);

assert.equal(
  pickNextGuestPort([7696, 7697, 7699], { startPort: 7696 }),
  7698,
);

const addedIngress = upsertCloudflaredIngress(baseConfig, {
  hostname: 'trial4.example.com',
  service: 'http://127.0.0.1:7699',
});
assert.match(
  addedIngress,
  /hostname: trial4\.example\.com\n\s+service: http:\/\/127\.0\.0\.1:7699\n\s+- service: http_status:404/,
  'should insert the new ingress entry before the fallback rule',
);

const updatedIngress = upsertCloudflaredIngress(baseConfig, {
  hostname: 'companion.example.com',
  service: 'http://127.0.0.1:7800',
});
assert.match(
  updatedIngress,
  /hostname: companion\.example\.com\n\s+service: http:\/\/127\.0\.0\.1:7800/,
  'should update an existing hostname entry in place',
);

const newConfig = upsertCloudflaredIngress('', {
  hostname: 'trial5.example.com',
  service: 'http://127.0.0.1:7700',
});
assert.match(newConfig, /^ingress:\n  - hostname: trial5\.example\.com/m, 'should create a new ingress section when absent');

const plist = buildLaunchAgentPlist({
  label: 'com.chatserver.trial4',
  nodePath: '/usr/local/bin/node',
  chatServerPath: '/Users/example/code/remotelab/chat-server.mjs',
  workingDirectory: '/Users/example/code/remotelab',
  standardOutPath: '/Users/example/Library/Logs/chat-server-trial4.log',
  standardErrorPath: '/Users/example/Library/Logs/chat-server-trial4.error.log',
  environmentVariables: {
    CHAT_PORT: '7699',
    REMOTELAB_INSTANCE_ROOT: '/Users/example/.remotelab/instances/trial4',
  },
});
assert.match(plist, /<string>com\.chatserver\.trial4<\/string>/);
assert.match(plist, /<key>CHAT_PORT<\/key><string>7699<\/string>/);
assert.match(plist, /<string>\/Users\/example\/code\/remotelab\/chat-server\.mjs<\/string>/);

const formatted = formatGuestInstance({
  name: 'trial16',
  port: 7710,
  localBaseUrl: 'http://127.0.0.1:7710',
  publicBaseUrl: 'https://trial16.example.com',
  mailboxAddress: 'rowan+trial16@jiujianian.dev',
  instanceRoot: '/Users/example/.remotelab/instances/trial16',
  configDir: '/Users/example/.remotelab/instances/trial16/config',
  memoryDir: '/Users/example/.remotelab/instances/trial16/memory',
  launchAgentPath: '/Users/example/Library/LaunchAgents/com.chatserver.trial16.plist',
  createdAt: '2026-03-24T00:00:00.000Z',
}, {
  localReachable: true,
});
assert.match(formatted, /mailbox: rowan\+trial16@jiujianian\.dev/);

const sandboxHome = mkdtempSync(join(tmpdir(), 'remotelab-guest-instance-'));
try {
  const launchAgentsDir = join(sandboxHome, 'Library', 'LaunchAgents');
  const logDir = join(sandboxHome, 'Library', 'Logs');
  const cloudflaredDir = join(sandboxHome, '.cloudflared');
  const instanceRoot = join(sandboxHome, '.remotelab', 'instances', 'trial');
  mkdirSync(launchAgentsDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  mkdirSync(cloudflaredDir, { recursive: true });
  mkdirSync(instanceRoot, { recursive: true });

  writeFileSync(join(cloudflaredDir, 'config.yml'), `tunnel: test-tunnel\n\ningress:\n  - hostname: trial.example.com\n    service: http://127.0.0.1:7696\n  - service: http_status:404\n`);

  writeFileSync(join(launchAgentsDir, 'com.chatserver.trial.plist'), buildLaunchAgentPlist({
    label: 'com.chatserver.trial',
    nodePath: '/usr/local/bin/node',
    chatServerPath: '/Users/example/code/remotelab-trial-runtime/chat-server.mjs',
    workingDirectory: '/Users/example/code/remotelab-trial-runtime',
    standardOutPath: join(logDir, 'chat-server-trial.log'),
    standardErrorPath: join(logDir, 'chat-server-trial.error.log'),
    environmentVariables: {
      CHAT_PORT: '7696',
      HOME: sandboxHome,
      REMOTELAB_ENABLE_ACTIVE_RELEASE: '1',
      REMOTELAB_INSTANCE_ROOT: instanceRoot,
      SECURE_COOKIES: '1',
    },
  }));

  const convergeResult = spawnSync('node', ['cli.js', 'guest-instance', 'converge', 'trial', '--dry-run', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: sandboxHome,
    },
  });
  assert.equal(convergeResult.status, 0, convergeResult.stderr || convergeResult.stdout);
  const convergeOutput = JSON.parse(convergeResult.stdout);
  assert.equal(convergeOutput.length, 1);
  assert.equal(convergeOutput[0].name, 'trial');
  assert.equal(convergeOutput[0].changed, true);
  assert.equal(convergeOutput[0].dryRun, true);
  assert.equal(convergeOutput[0].previousChatServerPath, '/Users/example/code/remotelab-trial-runtime/chat-server.mjs');
  assert.equal(convergeOutput[0].publicBaseUrl, 'https://trial.example.com');
  assert.equal(convergeOutput[0].nextChatServerPath, join(repoRoot, 'chat-server.mjs'));
  assert.equal(convergeOutput[0].nextWorkingDirectory, repoRoot);
  assert.equal(convergeOutput[0].drift.hasLegacyReleaseFlags, true);
} finally {
  rmSync(sandboxHome, { recursive: true, force: true });
}

console.log('test-guest-instance-command: ok');
