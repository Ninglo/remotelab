#!/usr/bin/env node
import assert from 'assert/strict';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import {
  buildAccessUrl,
  buildGuestMailboxAddress,
  buildMainlandBaseUrl,
  formatGuestInstance,
  formatGuestInstanceLinks,
  parseArgs,
  planGuestRuntimeDefaults,
  pickNextTrialInstanceName,
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
assert.equal(pickNextTrialInstanceName([]), 'trial1');
assert.equal(pickNextTrialInstanceName(['trial']), 'trial2');
assert.equal(pickNextTrialInstanceName(['trial1', 'trial2']), 'trial3');
assert.equal(pickNextTrialInstanceName([{ name: 'trial2' }, { name: 'demo' }]), 'trial3');
assert.equal(pickNextTrialInstanceName(['demo', 'trial4']), 'trial5');
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
assert.equal(buildAccessUrl('https://trial16.example.com', 'abc123'), 'https://trial16.example.com/?token=abc123');
assert.equal(
  buildMainlandBaseUrl('trial16', { mainlandBaseUrl: 'https://jojotry.nat100.top/' }),
  'https://jojotry.nat100.top/trial16',
);
assert.equal(parseArgs(['create-trial', '--json']).json, true);
assert.equal(parseArgs(['create-trial', '--json']).trial, true);
assert.equal(parseArgs(['create-trial', '--json']).command, 'create');
assert.equal(parseArgs(['links']).command, 'links');
assert.equal(parseArgs(['links', 'trial24', '--check']).name, 'trial24');
assert.equal(parseArgs(['links', 'trial24', '--check']).check, true);
assert.equal(parseArgs(['report']).command, 'report');
assert.equal(parseArgs(['report', 'trial24', '--output-dir', '/tmp/report']).name, 'trial24');
assert.equal(parseArgs(['report', '--send', '--send-json']).send, true);
assert.equal(parseArgs(['report', '--send', '--send-json']).sendJson, true);

const formattedLinks = formatGuestInstanceLinks([
  {
    name: 'trial24',
    accessUrl: 'https://trial24.example.com/?token=abc123',
    mainlandAccessUrl: 'https://jojotry.nat100.top/trial24/?token=abc123',
    localAccessUrl: 'http://127.0.0.1:7711/?token=abc123',
    mailboxAddress: 'trial24@example.com',
    localReachable: true,
    publicReachable: true,
    publicBaseUrl: 'https://trial24.example.com',
  },
], { check: true });
assert.match(formattedLinks, /name: trial24/);
assert.match(formattedLinks, /access: https:\/\/trial24\.example\.com\/\?token=abc123/);
assert.match(formattedLinks, /mainlandAccess: https:\/\/jojotry\.nat100\.top\/trial24\/\?token=abc123/);
assert.match(formattedLinks, /localAccess: http:\/\/127\.0\.0\.1:7711\/\?token=abc123/);
assert.match(formattedLinks, /mailbox: trial24@example\.com/);
assert.match(formattedLinks, /publicStatus: reachable/);

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
  mainlandBaseUrl: 'https://jojotry.nat100.top/trial16',
  mainlandAccessUrl: 'https://jojotry.nat100.top/trial16/?token=abc123',
  mailboxAddress: 'rowan+trial16@jiujianian.dev',
  mailboxRoutingStatus: 'synced',
  instanceRoot: '/Users/example/.remotelab/instances/trial16',
  configDir: '/Users/example/.remotelab/instances/trial16/config',
  memoryDir: '/Users/example/.remotelab/instances/trial16/memory',
  launchAgentPath: '/Users/example/Library/LaunchAgents/com.chatserver.trial16.plist',
  createdAt: '2026-03-24T00:00:00.000Z',
}, {
  token: 'abc123',
  localReachable: true,
});
assert.match(formatted, /mailbox: rowan\+trial16@jiujianian\.dev/);
assert.match(formatted, /mailboxRouting: synced/);
assert.match(formatted, /mainland: https:\/\/jojotry\.nat100\.top\/trial16/);
assert.match(formatted, /mainlandAccess: https:\/\/jojotry\.nat100\.top\/trial16\/\?token=abc123/);

const ownerMicroSelection = {
  selectedTool: 'micro-agent',
  selectedModel: 'gpt-5.4',
  selectedEffort: 'xhigh',
  thinkingEnabled: false,
  reasoningKind: 'enum',
};
const ownerTools = [
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
  plannedFreshGuestDefaults.tools[0].reasoning.kind,
  'none',
  'guest should mirror the owner tool reasoning config as-is',
);
assert.equal(
  plannedFreshGuestDefaults.selection.reasoningKind,
  'none',
  'guest reasoning kind should match the owner tool config',
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
    ...ownerTools[0],
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
  'reasoning kind none means no effort selection',
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
  plannedProductDefaultGuestDefaults.selection.reasoningKind,
  'none',
  'the product default should mirror the owner tool reasoning config',
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

// ---- Multi-model micro-agent router (non-codex runtimeFamily) ----
const ownerRouterTools = [
  {
    id: 'micro-agent',
    name: 'Micro Agent',
    command: '/Users/example/code/remotelab/scripts/micro-agent-router.mjs',
    toolProfile: 'micro-agent',
    runtimeFamily: 'claude-stream-json',
    promptMode: 'bare-user',
    flattenPrompt: true,
    visibility: 'private',
    models: [
      { id: 'gpt-5.4', label: 'gpt-5.4', defaultReasoning: 'medium' },
      { id: 'opus', label: 'Claude Opus', defaultReasoning: 'medium' },
      { id: 'sonnet', label: 'Claude Sonnet', defaultReasoning: 'medium' },
      { id: 'doubao-seed-2-0-pro-260215', label: 'Doubao Pro', defaultReasoning: 'medium' },
    ],
    reasoning: { kind: 'none', label: 'Thinking' },
  },
];

const plannedRouterFreshGuest = planGuestRuntimeDefaults({
  ownerSelection: ownerMicroSelection,
  ownerTools: ownerRouterTools,
  guestSelection: null,
  guestTools: [],
  detectedModel: 'gpt-5.4',
});
assert.deepEqual(
  plannedRouterFreshGuest.tools.map((tool) => tool.id),
  ['micro-agent'],
  'router-based micro-agent should sync to fresh guest instances',
);
assert.equal(
  plannedRouterFreshGuest.tools[0].command,
  '/Users/example/code/remotelab/scripts/micro-agent-router.mjs',
  'router command path should be preserved in guest copy',
);
assert.equal(
  plannedRouterFreshGuest.tools[0].runtimeFamily,
  'claude-stream-json',
  'runtimeFamily should be preserved in guest copy',
);
assert.deepEqual(
  plannedRouterFreshGuest.tools[0].models.map((m) => m.id),
  ['gpt-5.4', 'opus', 'sonnet', 'doubao-seed-2-0-pro-260215'],
  'all four models (GPT, Claude Opus, Claude Sonnet, Doubao) must be present in guest copy',
);
assert.equal(
  plannedRouterFreshGuest.selection.selectedTool,
  'micro-agent',
  'fresh guest should default to micro-agent when available',
);
assert.deepEqual(
  plannedRouterFreshGuest.tools[0].reasoning,
  { kind: 'none', label: 'Thinking' },
  'non-codex micro-agent should preserve original reasoning (not force enum)',
);

const plannedRouterStaleGuest = planGuestRuntimeDefaults({
  ownerSelection: ownerMicroSelection,
  ownerTools: ownerRouterTools,
  guestSelection: {
    selectedTool: 'micro-agent',
    selectedModel: 'gpt-5.4',
    selectedEffort: 'medium',
    thinkingEnabled: false,
    reasoningKind: 'enum',
  },
  guestTools: [{
    id: 'micro-agent',
    name: 'Micro Agent',
    command: 'codex',
    toolProfile: 'micro-agent',
    runtimeFamily: 'codex-json',
    models: [{ id: 'gpt-5.4', label: 'gpt-5.4' }],
    reasoning: { kind: 'enum', label: 'Thinking', levels: ['low', 'medium', 'high', 'xhigh'], default: 'medium' },
  }],
  detectedModel: 'gpt-5.4',
});
assert.equal(
  plannedRouterStaleGuest.tools[0].command,
  '/Users/example/code/remotelab/scripts/micro-agent-router.mjs',
  'stale codex-based guest tool should be upgraded to the router command',
);
assert.equal(
  plannedRouterStaleGuest.tools[0].runtimeFamily,
  'claude-stream-json',
  'stale guest runtimeFamily should be upgraded from codex-json to claude-stream-json',
);
assert.equal(
  plannedRouterStaleGuest.tools[0].models.length,
  4,
  'stale guest should receive all four models after sync',
);
assert.deepEqual(
  plannedRouterStaleGuest.tools[0].models.map((m) => m.id),
  ['gpt-5.4', 'opus', 'sonnet', 'doubao-seed-2-0-pro-260215'],
  'stale guest model list should match owner exactly',
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
  assert.equal(convergeOutput[0].drift.missingPublicBaseUrl, true);
  assert.equal(convergeOutput[0].drift.fileAssetEnvironmentChanged, true);
} finally {
  rmSync(sandboxHome, { recursive: true, force: true });
}

const syncSandboxHome = mkdtempSync(join(tmpdir(), 'remotelab-guest-instance-sync-'));
try {
  const launchAgentsDir = join(syncSandboxHome, 'Library', 'LaunchAgents');
  const logDir = join(syncSandboxHome, 'Library', 'Logs');
  const ownerConfigDir = join(syncSandboxHome, '.config', 'remotelab');
  const instanceRoot = join(syncSandboxHome, '.remotelab', 'instances', 'trial');
  mkdirSync(launchAgentsDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  mkdirSync(ownerConfigDir, { recursive: true });
  mkdirSync(instanceRoot, { recursive: true });
  writeFileSync(join(ownerConfigDir, 'guest-instance-defaults.json'), JSON.stringify({
    mainlandBaseUrl: 'https://jojotry.nat100.top',
  }, null, 2));

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
  assert.match(rewrittenGuestPlist, /<key>REMOTELAB_GUEST_MAINLAND_BASE_URL<\/key><string>https:\/\/jojotry\.nat100\.top<\/string>/);
  assert.doesNotMatch(rewrittenGuestPlist, /<key>REMOTELAB_ENABLE_ACTIVE_RELEASE<\/key>/);
} finally {
  rmSync(syncSandboxHome, { recursive: true, force: true });
}

const linksSandboxHome = mkdtempSync(join(tmpdir(), 'remotelab-guest-instance-links-'));
try {
  const configDir = join(linksSandboxHome, '.config', 'remotelab');
  const instanceRoot = join(linksSandboxHome, '.remotelab', 'instances', 'trial24');
  const instanceConfigDir = join(instanceRoot, 'config');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(instanceConfigDir, { recursive: true });
  writeFileSync(join(configDir, 'guest-instance-defaults.json'), JSON.stringify({
    mainlandBaseUrl: 'https://jojotry.nat100.top',
  }, null, 2));
  writeFileSync(join(configDir, 'guest-instances.json'), JSON.stringify([
    {
      name: 'trial24',
      label: 'com.chatserver.trial24',
      port: 7711,
      hostname: 'trial24.example.com',
      instanceRoot,
      configDir: instanceConfigDir,
      memoryDir: join(instanceRoot, 'memory'),
      authFile: join(instanceConfigDir, 'auth.json'),
      launchAgentPath: join(linksSandboxHome, 'Library', 'LaunchAgents', 'com.chatserver.trial24.plist'),
      logPath: join(linksSandboxHome, 'Library', 'Logs', 'chat-server-trial24.log'),
      errorLogPath: join(linksSandboxHome, 'Library', 'Logs', 'chat-server-trial24.error.log'),
      publicBaseUrl: 'https://trial24.example.com',
      localBaseUrl: 'http://127.0.0.1:7711',
      sessionExpiryDays: 30,
      createdAt: '2026-03-26T14:56:25.700Z',
    },
  ], null, 2));
  writeFileSync(join(instanceConfigDir, 'auth.json'), JSON.stringify({ token: 'abc123' }, null, 2));

  const linksResult = spawnSync('node', ['cli.js', 'guest-instance', 'links', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: linksSandboxHome,
    },
  });
  assert.equal(linksResult.status, 0, linksResult.stderr || linksResult.stdout);
  const linksOutput = JSON.parse(linksResult.stdout);
  assert.equal(linksOutput.length, 1);
  assert.equal(linksOutput[0].name, 'trial24');
  assert.equal(linksOutput[0].accessUrl, 'https://trial24.example.com/?token=abc123');
  assert.equal(linksOutput[0].mainlandAccessUrl, 'https://jojotry.nat100.top/trial24/?token=abc123');
  assert.equal(linksOutput[0].localAccessUrl, 'http://127.0.0.1:7711/?token=abc123');

const singleLinksResult = spawnSync('node', ['cli.js', 'guest-instance', 'links', 'trial24', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: linksSandboxHome,
    },
  });
  assert.equal(singleLinksResult.status, 0, singleLinksResult.stderr || singleLinksResult.stdout);
  const singleLinksOutput = JSON.parse(singleLinksResult.stdout);
  assert.equal(singleLinksOutput.name, 'trial24');
  assert.equal(singleLinksOutput.accessUrl, 'https://trial24.example.com/?token=abc123');
} finally {
  rmSync(linksSandboxHome, { recursive: true, force: true });
}

const reportSandboxHome = mkdtempSync(join(tmpdir(), 'remotelab-guest-instance-report-'));
try {
  const configDir = join(reportSandboxHome, '.config', 'remotelab');
  const outputDir = join(reportSandboxHome, '.remotelab', 'reports');
  const trialRoot = join(reportSandboxHome, '.remotelab', 'instances', 'trial24');
  const intakeRoot = join(reportSandboxHome, '.remotelab', 'instances', 'intake1');
  const emptyRoot = join(reportSandboxHome, '.remotelab', 'instances', 'trial25');
  const trialConfigDir = join(trialRoot, 'config');
  const intakeConfigDir = join(intakeRoot, 'config');
  const emptyConfigDir = join(emptyRoot, 'config');
  const reportNow = new Date();
  const recentUpdate = new Date(reportNow.getTime() - 60 * 60 * 1000).toISOString();
  const earlierUpdate = new Date(reportNow.getTime() - 2 * 60 * 60 * 1000).toISOString();
  const createdFirst = new Date(reportNow.getTime() - 5 * 60 * 60 * 1000).toISOString();
  const createdSecond = new Date(reportNow.getTime() - 4 * 60 * 60 * 1000).toISOString();
  mkdirSync(configDir, { recursive: true });
  mkdirSync(trialConfigDir, { recursive: true });
  mkdirSync(intakeConfigDir, { recursive: true });
  mkdirSync(emptyConfigDir, { recursive: true });

  writeFileSync(join(configDir, 'guest-instance-defaults.json'), JSON.stringify({
    mainlandBaseUrl: 'https://jojotry.nat100.top',
  }, null, 2));
  writeFileSync(join(configDir, 'guest-instances.json'), JSON.stringify([
    {
      name: 'trial24',
      label: 'com.chatserver.trial24',
      port: 7711,
      hostname: 'trial24.example.com',
      instanceRoot: trialRoot,
      configDir: trialConfigDir,
      memoryDir: join(trialRoot, 'memory'),
      authFile: join(trialConfigDir, 'auth.json'),
      publicBaseUrl: 'https://trial24.example.com',
      localBaseUrl: 'http://127.0.0.1:7711',
      createdAt: '2026-03-26T14:56:25.700Z',
    },
    {
      name: 'intake1',
      label: 'com.chatserver.intake1',
      port: 7703,
      hostname: 'intake1.example.com',
      instanceRoot: intakeRoot,
      configDir: intakeConfigDir,
      memoryDir: join(intakeRoot, 'memory'),
      authFile: join(intakeConfigDir, 'auth.json'),
      publicBaseUrl: 'https://intake1.example.com',
      localBaseUrl: 'http://127.0.0.1:7703',
      createdAt: '2026-03-25T10:00:00.000Z',
    },
    {
      name: 'trial25',
      label: 'com.chatserver.trial25',
      port: 7712,
      hostname: 'trial25.example.com',
      instanceRoot: emptyRoot,
      configDir: emptyConfigDir,
      memoryDir: join(emptyRoot, 'memory'),
      authFile: join(emptyConfigDir, 'auth.json'),
      publicBaseUrl: 'https://trial25.example.com',
      localBaseUrl: 'http://127.0.0.1:7712',
      createdAt: '2026-03-20T10:00:00.000Z',
    },
  ], null, 2));

  writeFileSync(join(trialConfigDir, 'auth.json'), JSON.stringify({ token: 'trial-token' }, null, 2));
  writeFileSync(join(intakeConfigDir, 'auth.json'), JSON.stringify({ token: 'intake-token' }, null, 2));
  writeFileSync(join(emptyConfigDir, 'auth.json'), JSON.stringify({ token: 'empty-token' }, null, 2));

  writeFileSync(join(trialConfigDir, 'auth-sessions.json'), JSON.stringify({ a: {}, b: {} }, null, 2));
  writeFileSync(join(intakeConfigDir, 'auth-sessions.json'), JSON.stringify([{ id: 'auth1' }], null, 2));
  writeFileSync(join(emptyConfigDir, 'auth-sessions.json'), JSON.stringify([], null, 2));

  writeFileSync(join(trialConfigDir, 'chat-sessions.json'), JSON.stringify([
    {
      id: 'sess-trial-1',
      createdAt: createdFirst,
      updatedAt: earlierUpdate,
      name: 'Trial 24 session 1',
    },
    {
      id: 'sess-trial-2',
      createdAt: createdSecond,
      updatedAt: recentUpdate,
      name: 'Trial 24 session 2',
    },
  ], null, 2));
  writeFileSync(join(intakeConfigDir, 'chat-sessions.json'), JSON.stringify([], null, 2));
  writeFileSync(join(emptyConfigDir, 'chat-sessions.json'), JSON.stringify([], null, 2));

  mkdirSync(join(trialConfigDir, 'usage-ledger'), { recursive: true });
  mkdirSync(join(intakeConfigDir, 'usage-ledger'), { recursive: true });

  writeFileSync(join(trialConfigDir, 'usage-ledger', '2026-03-26.jsonl'), [
    JSON.stringify({
      ts: '2026-03-26T14:00:00.000Z',
      runId: 'run_trial24_1',
      sessionId: 'sess-trial-1',
      sessionName: 'Trial 24 session 1',
      principalType: 'owner',
      principalId: 'owner',
      principalName: 'Owner',
      tool: 'claude',
      model: 'claude-sonnet',
      state: 'completed',
      totalTokens: 150,
      inputTokens: 120,
      outputTokens: 30,
      costUsd: 0.25,
      operation: 'user_turn',
    }),
    JSON.stringify({
      ts: '2026-03-27T14:00:00.000Z',
      runId: 'run_trial24_2',
      sessionId: 'sess-trial-2',
      sessionName: 'Trial 24 session 2',
      principalType: 'owner',
      principalId: 'owner',
      principalName: 'Owner',
      tool: 'micro-agent',
      model: 'gpt-5.4',
      state: 'completed',
      totalTokens: 240,
      inputTokens: 180,
      outputTokens: 60,
      cachedInputTokens: 90,
      estimatedCostUsd: 0.4,
      estimatedCostModel: 'gpt-5.4',
      costSource: 'estimated_gpt_5_4',
      operation: 'user_turn',
    }),
  ].join('\n') + '\n');

  writeFileSync(join(intakeConfigDir, 'usage-ledger', '2026-03-27.jsonl'), [
    JSON.stringify({
      ts: '2026-03-27T16:00:00.000Z',
      runId: 'run_intake1_1',
      sessionId: 'sess-intake-1',
      sessionName: 'Intake session',
      principalType: 'owner',
      principalId: 'owner',
      principalName: 'Owner',
      tool: 'codex',
      model: 'gpt-5.4',
      state: 'completed',
      totalTokens: 90,
      inputTokens: 70,
      outputTokens: 20,
      cachedInputTokens: 20,
      estimatedCostUsd: 0.12,
      estimatedCostModel: 'gpt-5.4',
      costSource: 'estimated_gpt_5_4',
      operation: 'user_turn',
    }),
  ].join('\n') + '\n');

  const reportResult = spawnSync('node', ['cli.js', 'guest-instance', 'report', '--json', '--output-dir', outputDir], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: reportSandboxHome,
    },
  });
  assert.equal(reportResult.status, 0, reportResult.stderr || reportResult.stdout);
  const reportOutput = JSON.parse(reportResult.stdout);
  assert.equal(reportOutput.summary.totalCount, 3);
  assert.equal(reportOutput.summary.occupiedCount, 1);
  assert.equal(reportOutput.summary.openedCount, 1);
  assert.equal(reportOutput.summary.emptyCount, 1);
  assert.equal(reportOutput.summary.topActiveNames[0], 'trial24');
  assert.deepEqual(reportOutput.summary.emptyNames, ['trial25']);
  assert.equal(reportOutput.summary.usage.windowDays, 30);
  assert.equal(reportOutput.summary.usage.activeInstanceCount, 2);
  assert.equal(reportOutput.summary.usage.totalTokens, 480);
  assert.equal(reportOutput.summary.usage.costUsd, 0.25);
  assert.equal(reportOutput.summary.usage.estimatedCostUsd, 0.52);
  assert.equal(reportOutput.summary.usage.byTool[0].key, 'micro-agent');

  const trial24 = reportOutput.instances.find((entry) => entry.name === 'trial24');
  const intake1 = reportOutput.instances.find((entry) => entry.name === 'intake1');
  const trial25 = reportOutput.instances.find((entry) => entry.name === 'trial25');
  assert.equal(trial24.status, 'active');
  assert.equal(trial24.sessionCount, 2);
  assert.equal(trial24.authSessionCount, 2);
  assert.equal(trial24.bestAccessUrl, 'https://trial24.example.com/?token=trial-token');
  assert.equal(trial24.usageSummary.totals.totalTokens, 390);
  assert.equal(trial24.usageSummary.totals.costUsd, 0.25);
  assert.equal(trial24.usageSummary.totals.estimatedCostUsd, 0.4);
  assert.equal(trial24.usageSummary.byTool[0].key, 'micro-agent');
  assert.equal(intake1.status, 'opened');
  assert.equal(intake1.sessionCount, 0);
  assert.equal(intake1.authSessionCount, 1);
  assert.equal(intake1.usageSummary.totals.totalTokens, 90);
  assert.equal(intake1.usageSummary.totals.estimatedCostUsd, 0.12);
  assert.equal(intake1.usageSummary.byTool[0].key, 'codex');
  assert.equal(trial25.status, 'empty');

  assert.match(readFileSync(reportOutput.markdownPath, 'utf8'), /# Guest Instance Usage Report/);
  assert.match(readFileSync(reportOutput.markdownPath, 'utf8'), /\| trial24 \| active \|/);
  assert.match(readFileSync(reportOutput.markdownPath, 'utf8'), /30d Tokens/);
  assert.match(readFileSync(reportOutput.markdownPath, 'utf8'), /\[open\]\(https:\/\/trial24\.example\.com\/\?token=trial-token\)/);
  assert.match(readFileSync(reportOutput.csvPath, 'utf8'), /trial24,active,recent activity,7711,2,2/);
  assert.match(readFileSync(reportOutput.jsonPath, 'utf8'), /"scope": "all"/);

  const singleReportResult = spawnSync('node', ['cli.js', 'guest-instance', 'report', 'intake1', '--json', '--output-dir', outputDir], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: reportSandboxHome,
    },
  });
  assert.equal(singleReportResult.status, 0, singleReportResult.stderr || singleReportResult.stdout);
  const singleReportOutput = JSON.parse(singleReportResult.stdout);
  assert.equal(singleReportOutput.scope, 'intake1');
  assert.equal(singleReportOutput.instances.length, 1);
  assert.equal(singleReportOutput.instances[0].name, 'intake1');
} finally {
  rmSync(reportSandboxHome, { recursive: true, force: true });
}

console.log('test-guest-instance-command: ok');
