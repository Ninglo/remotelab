#!/usr/bin/env node
import assert from 'assert/strict';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import {
  buildGuestMailboxAddress,
  formatGuestInstance,
  planGuestRuntimeDefaults,
  syncGuestMailboxProvisioning,
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
const ownerFileAssetEnvironment = {
  REMOTELAB_ASSET_STORAGE_PROVIDER: 'tos',
  REMOTELAB_ASSET_STORAGE_BASE_URL: 'https://assets.example.com',
  REMOTELAB_ASSET_STORAGE_REGION: 'cn-beijing',
  REMOTELAB_ASSET_STORAGE_ACCESS_KEY_ID: 'example-access-key',
  REMOTELAB_ASSET_STORAGE_SECRET_ACCESS_KEY: 'example-secret-key',
  REMOTELAB_ASSET_STORAGE_KEY_PREFIX: 'session-assets',
  REMOTELAB_ASSET_DIRECT_UPLOAD_ENABLED: '0',
};

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

const syncedProvisioning = await syncGuestMailboxProvisioning({ name: 'trial16' }, {
  mailboxIdentity: {
    localPart: 'rowan',
    domain: 'jiujianian.dev',
    instanceAddressMode: 'local_part',
  },
  syncCloudflareRoutingFn: async () => ({
    desiredRouteModel: 'literal_worker_rules_per_address',
    operations: [{ type: 'literal_worker_rule', action: 'created' }],
  }),
});
assert.equal(syncedProvisioning.mailboxAddress, 'trial16@jiujianian.dev');
assert.equal(syncedProvisioning.status, 'synced');
assert.equal(syncedProvisioning.desiredRouteModel, 'literal_worker_rules_per_address');
assert.equal(syncedProvisioning.operations.length, 1);

const skippedProvisioning = await syncGuestMailboxProvisioning({ name: 'trial16' }, {
  mailboxIdentity: { localPart: 'rowan', domain: 'jiujianian.dev' },
  mailboxSync: false,
});
assert.equal(skippedProvisioning.mailboxAddress, 'rowan+trial16@jiujianian.dev');
assert.equal(skippedProvisioning.status, 'skipped');

const unconfiguredProvisioning = await syncGuestMailboxProvisioning({ name: 'trial16' }, {
  mailboxIdentity: null,
});
assert.equal(unconfiguredProvisioning.mailboxAddress, '');
assert.equal(unconfiguredProvisioning.status, 'unconfigured');

const failedProvisioning = await syncGuestMailboxProvisioning({ name: 'trial16' }, {
  mailboxIdentity: { localPart: 'rowan', domain: 'jiujianian.dev' },
  syncCloudflareRoutingFn: async () => {
    throw new Error('bad token');
  },
});
assert.equal(failedProvisioning.mailboxAddress, 'rowan+trial16@jiujianian.dev');
assert.equal(failedProvisioning.status, 'failed');
assert.match(failedProvisioning.detail, /bad token/);

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
  mailboxRoutingStatus: 'synced',
  instanceRoot: '/Users/example/.remotelab/instances/trial16',
  configDir: '/Users/example/.remotelab/instances/trial16/config',
  memoryDir: '/Users/example/.remotelab/instances/trial16/memory',
  launchAgentPath: '/Users/example/Library/LaunchAgents/com.chatserver.trial16.plist',
  createdAt: '2026-03-24T00:00:00.000Z',
}, {
  localReachable: true,
});
assert.match(formatted, /mailbox: rowan\+trial16@jiujianian\.dev/);
assert.match(formatted, /mailboxRouting: synced/);

const ownerMicroSelection = {
  selectedTool: 'micro-agent',
  selectedModel: 'gpt-5.4',
  selectedEffort: 'xhigh',
  thinkingEnabled: false,
  reasoningKind: 'enum',
};
const ownerTools = [
  {
    id: 'doubao-fast',
    name: 'Doubao Fast Agent',
    command: '/Users/example/code/remotelab/scripts/doubao-fast-agent.mjs',
    runtimeFamily: 'claude-stream-json',
    visibility: 'private',
  },
  {
    id: 'micro-agent',
    name: 'Micro Agent',
    command: 'codex',
    toolProfile: 'micro-agent',
    runtimeFamily: 'codex-json',
    models: [{ id: 'gpt-5.4', label: 'gpt-5.4' }],
    reasoning: { kind: 'none', label: 'Thinking' },
  },
];

const plannedLegacyGuestDefaults = planGuestRuntimeDefaults({
  ownerSelection: ownerMicroSelection,
  ownerTools,
  guestSelection: {
    selectedTool: 'codex',
    selectedModel: '',
    selectedEffort: 'medium',
    thinkingEnabled: false,
    reasoningKind: 'enum',
  },
  guestTools: [],
  detectedModel: 'gpt-5.4',
});
assert.deepEqual(
  plannedLegacyGuestDefaults.tools.map((tool) => tool.id),
  ['micro-agent'],
  'legacy guests should inherit safe Codex-backed owner presets',
);
assert.equal(
  plannedLegacyGuestDefaults.selection.selectedTool,
  'codex',
  'legacy guests should keep an existing valid built-in selection during convergence',
);

const plannedFreshGuestDefaults = planGuestRuntimeDefaults({
  ownerSelection: ownerMicroSelection,
  ownerTools,
  guestSelection: null,
  guestTools: [],
  detectedModel: 'gpt-5.4',
});
assert.equal(
  plannedFreshGuestDefaults.selection.selectedTool,
  'micro-agent',
  'fresh guests should still inherit the owner-selected micro-agent preset',
);
assert.equal(
  plannedFreshGuestDefaults.selection.selectedModel,
  'gpt-5.4',
  'fresh guests should keep the micro-agent model default',
);
assert.equal(
  plannedFreshGuestDefaults.selection.selectedEffort,
  '',
  'micro-agent defaults should clear stale enum effort values',
);
assert.equal(
  plannedFreshGuestDefaults.selection.reasoningKind,
  'none',
  'micro-agent defaults should follow the tool reasoning mode',
);

const plannedUpdatedGuestDefaults = planGuestRuntimeDefaults({
  ownerSelection: ownerMicroSelection,
  ownerTools,
  guestSelection: {
    selectedTool: 'micro-agent',
    selectedModel: 'gpt-5.2-codex',
    selectedEffort: 'medium',
    thinkingEnabled: false,
    reasoningKind: 'enum',
  },
  guestTools: [{
    ...ownerTools[1],
    models: [{ id: 'gpt-5.2-codex', label: 'gpt-5.2-codex' }],
  }],
  detectedModel: 'gpt-5.4',
});
assert.equal(
  plannedUpdatedGuestDefaults.tools[0].models[0].id,
  'gpt-5.4',
  'safe owner presets should refresh stale guest copies by tool id',
);
assert.equal(
  plannedUpdatedGuestDefaults.selection.selectedModel,
  'gpt-5.4',
  'stale guest model selections should be normalized to the current tool default',
);
assert.equal(
  plannedUpdatedGuestDefaults.selection.selectedEffort,
  '',
  'non-reasoning tools should not keep stale effort values',
);

const plannedProductDefaultGuestDefaults = planGuestRuntimeDefaults({
  ownerSelection: null,
  ownerTools,
  guestSelection: null,
  guestTools: [],
  detectedModel: 'gpt-5.4',
});
assert.equal(
  plannedProductDefaultGuestDefaults.selection.selectedTool,
  'micro-agent',
  'new guest instances should prefer Micro Agent when it is available',
);
assert.equal(
  plannedProductDefaultGuestDefaults.selection.selectedEffort,
  '',
  'the product default should not hardcode a Codex reasoning level',
);
assert.equal(
  plannedProductDefaultGuestDefaults.selection.reasoningKind,
  'none',
  'the product default should inherit the tool reasoning mode',
);

const plannedCodexFallbackDefaults = planGuestRuntimeDefaults({
  ownerSelection: null,
  ownerTools: [],
  guestSelection: null,
  guestTools: [],
  detectedModel: 'gpt-5.4',
});
assert.equal(
  plannedCodexFallbackDefaults.selection.selectedTool,
  'codex',
  'guests should still fall back to Codex when Micro Agent is unavailable',
);
assert.equal(
  plannedCodexFallbackDefaults.selection.selectedModel,
  'gpt-5.4',
  'Codex fallback should still adopt the detected owner model',
);
assert.equal(
  plannedCodexFallbackDefaults.selection.selectedEffort,
  '',
  'Codex fallback should rely on the tool default instead of a hardcoded effort level',
);

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

  writeFileSync(join(launchAgentsDir, 'com.chatserver.claude.plist'), buildLaunchAgentPlist({
    label: 'com.chatserver.claude',
    nodePath: '/usr/local/bin/node',
    chatServerPath: '/Users/example/code/remotelab/chat-server.mjs',
    workingDirectory: '/Users/example/code/remotelab',
    standardOutPath: join(logDir, 'chat-server-owner.log'),
    standardErrorPath: join(logDir, 'chat-server-owner.error.log'),
    environmentVariables: {
      CHAT_PORT: '7690',
      HOME: sandboxHome,
      ...ownerFileAssetEnvironment,
      SECURE_COOKIES: '1',
    },
  }));

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
      ...ownerFileAssetEnvironment,
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
  assert.equal(convergeOutput[0].drift.fileAssetEnvironmentChanged, true);
} finally {
  rmSync(sandboxHome, { recursive: true, force: true });
}

const syncSandboxHome = mkdtempSync(join(tmpdir(), 'remotelab-guest-instance-sync-'));
try {
  const launchAgentsDir = join(syncSandboxHome, 'Library', 'LaunchAgents');
  const logDir = join(syncSandboxHome, 'Library', 'Logs');
  const instanceRoot = join(syncSandboxHome, '.remotelab', 'instances', 'trial');
  mkdirSync(launchAgentsDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  mkdirSync(instanceRoot, { recursive: true });

  writeFileSync(join(launchAgentsDir, 'com.chatserver.claude.plist'), buildLaunchAgentPlist({
    label: 'com.chatserver.claude',
    nodePath: '/usr/local/bin/node',
    chatServerPath: '/Users/example/code/remotelab/chat-server.mjs',
    workingDirectory: '/Users/example/code/remotelab',
    standardOutPath: join(logDir, 'chat-server-owner.log'),
    standardErrorPath: join(logDir, 'chat-server-owner.error.log'),
    environmentVariables: {
      CHAT_PORT: '7690',
      HOME: syncSandboxHome,
      ...ownerFileAssetEnvironment,
      SECURE_COOKIES: '1',
    },
  }));

  const guestPlistPath = join(launchAgentsDir, 'com.chatserver.trial.plist');
  writeFileSync(guestPlistPath, buildLaunchAgentPlist({
    label: 'com.chatserver.trial',
    nodePath: '/usr/local/bin/node',
    chatServerPath: '/Users/example/code/remotelab-legacy/chat-server.mjs',
    workingDirectory: '/Users/example/code/remotelab-legacy',
    standardOutPath: join(logDir, 'chat-server-trial.log'),
    standardErrorPath: join(logDir, 'chat-server-trial.error.log'),
    environmentVariables: {
      CHAT_PORT: '7696',
      HOME: syncSandboxHome,
      REMOTELAB_INSTANCE_ROOT: instanceRoot,
      SECURE_COOKIES: '1',
    },
  }));

  const convergeResult = spawnSync('node', ['cli.js', 'guest-instance', 'converge', 'trial', '--no-restart', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: syncSandboxHome,
      ...ownerFileAssetEnvironment,
    },
  });
  assert.equal(convergeResult.status, 0, convergeResult.stderr || convergeResult.stdout);
  const convergeOutput = JSON.parse(convergeResult.stdout);
  assert.equal(convergeOutput.length, 1);
  assert.equal(convergeOutput[0].name, 'trial');
  assert.equal(convergeOutput[0].changed, true);
  assert.equal(convergeOutput[0].restarted, false);

  const rewrittenGuestPlist = readFileSync(guestPlistPath, 'utf8');
  assert.match(rewrittenGuestPlist, /<key>REMOTELAB_ASSET_STORAGE_PROVIDER<\/key><string>tos<\/string>/);
  assert.match(rewrittenGuestPlist, /<key>REMOTELAB_ASSET_STORAGE_BASE_URL<\/key><string>https:\/\/assets\.example\.com<\/string>/);
  assert.match(rewrittenGuestPlist, /<key>REMOTELAB_ASSET_DIRECT_UPLOAD_ENABLED<\/key><string>0<\/string>/);
  assert.doesNotMatch(rewrittenGuestPlist, /<key>REMOTELAB_ENABLE_ACTIVE_RELEASE<\/key>/);
} finally {
  rmSync(syncSandboxHome, { recursive: true, force: true });
}

console.log('test-guest-instance-command: ok');
