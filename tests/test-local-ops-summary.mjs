#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-local-ops-'));

function writeText(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf8');
}

function launchAgentPlist({ label, port, instanceRoot }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CHAT_PORT</key>
    <string>${port}</string>
    <key>REMOTELAB_INSTANCE_ROOT</key>
    <string>${instanceRoot}</string>
  </dict>
</dict>
</plist>
`;
}

writeText(
  join(tempHome, '.cloudflared', 'config.yml'),
  `ingress:
  - hostname: trial.example.com
    service: http://127.0.0.1:7696
  - hostname: trial5.example.com
    service: http://127.0.0.1:7700
  - service: http_status:404
`,
);

writeText(
  join(tempHome, 'Library', 'LaunchAgents', 'com.chatserver.trial.plist'),
  launchAgentPlist({
    label: 'com.chatserver.trial',
    port: 7696,
    instanceRoot: join(tempHome, '.remotelab', 'instances', 'trial'),
  }),
);

writeText(
  join(tempHome, 'Library', 'LaunchAgents', 'com.chatserver.trial5.plist'),
  launchAgentPlist({
    label: 'com.chatserver.trial5',
    port: 7700,
    instanceRoot: join(tempHome, '.remotelab', 'instances', 'trial5'),
  }),
);

writeText(
  join(tempHome, '.config', 'remotelab', 'guest-instances.json'),
  `${JSON.stringify([
    {
      name: 'trial5',
      label: 'com.chatserver.trial5',
      port: 7700,
      hostname: 'trial5.example.com',
      instanceRoot: join(tempHome, '.remotelab', 'instances', 'trial5'),
      configDir: join(tempHome, '.remotelab', 'instances', 'trial5', 'config'),
      publicBaseUrl: 'https://trial5.example.com',
      localBaseUrl: 'http://127.0.0.1:7700',
    },
  ], null, 2)}\n`,
);

writeText(
  join(tempHome, '.remotelab', 'instances', 'trial', 'config', 'chat-sessions.json'),
  `${JSON.stringify([
    {
      id: 'session_trial',
      created: '2026-03-24T01:00:00.000Z',
      updatedAt: '2026-03-24T04:00:00.000Z',
      name: 'Trial active session',
      workflowState: 'done',
      workflowPriority: 'low',
    },
  ], null, 2)}\n`,
);

writeText(
  join(tempHome, '.remotelab', 'instances', 'trial', 'config', 'chat-history', 'session_trial', 'meta.json'),
  `${JSON.stringify({
    latestSeq: 20,
    lastEventAt: Date.parse('2026-03-24T04:00:00.000Z'),
    size: 20,
    counts: {
      message_user: 2,
      message_assistant: 3,
    },
  }, null, 2)}\n`,
);

writeText(
  join(tempHome, '.remotelab', 'instances', 'trial', 'config', 'api-logs', '2026-03-24.jsonl'),
  [
    JSON.stringify({ ts: '2026-03-24T03:00:00.000Z', pathname: '/api/build-info', route: 'GET /api/build-info' }),
    JSON.stringify({ ts: '2026-03-24T03:01:00.000Z', method: 'POST', pathname: '/api/sessions', route: 'POST /api/sessions' }),
    JSON.stringify({ ts: '2026-03-24T03:02:00.000Z', pathname: '/api/sessions/abc/events', route: 'GET /api/sessions/:sessionId/events' }),
    JSON.stringify({ ts: '2026-03-24T03:03:00.000Z', method: 'POST', pathname: '/api/sessions/session_trial/messages', route: 'POST /api/sessions/:sessionId/messages' }),
    JSON.stringify({ ts: '2026-03-24T03:04:00.000Z', method: 'POST', pathname: '/api/sessions/session_trial/messages', route: 'POST /api/sessions/:sessionId/messages' }),
  ].join('\n') + '\n',
);

writeText(
  join(tempHome, '.remotelab', 'instances', 'trial5', 'config', 'chat-sessions.json'),
  `${JSON.stringify([
    {
      id: 'session_trial5',
      created: '2026-03-24T02:00:00.000Z',
      updatedAt: '2026-03-24T02:30:00.000Z',
      name: 'Trial5 follow-up session',
      workflowState: 'waiting_user',
      workflowPriority: 'high',
    },
  ], null, 2)}\n`,
);

writeText(
  join(tempHome, '.remotelab', 'instances', 'trial5', 'config', 'chat-history', 'session_trial5', 'meta.json'),
  `${JSON.stringify({
    latestSeq: 6,
    lastEventAt: Date.parse('2026-03-24T02:30:00.000Z'),
    size: 6,
    counts: {
      message_user: 0,
      message_assistant: 1,
    },
  }, null, 2)}\n`,
);

writeText(
  join(tempHome, '.remotelab', 'instances', 'trial5', 'config', 'api-logs', '2026-03-24.jsonl'),
  [
    JSON.stringify({ ts: '2026-03-24T03:00:00.000Z', pathname: '/api/build-info', route: 'GET /api/build-info' }),
    JSON.stringify({ ts: '2026-03-24T03:05:00.000Z', pathname: '/api/sessions', route: 'GET /api/sessions' }),
  ].join('\n') + '\n',
);

const { collectLocalOpsReport, generateLocalOpsSidecar, renderLocalOpsSummary } = await import(
  pathToFileURL(join(repoRoot, 'lib', 'local-ops-summary.mjs')).href
);

try {
  const hostMetrics = {
    generatedAt: '2026-03-24T12:00:00.000Z',
    hostname: 'test-host',
    platform: process.platform,
    uptimeSeconds: 3600,
    cpuCount: 8,
    loadAvg: { one: 1.2, five: 1.1, fifteen: 1.0 },
    cpuUserPercent: 12,
    cpuSysPercent: 8,
    cpuIdlePercent: 80,
    totalMemoryBytes: 32 * 1024 ** 3,
    freeMemoryBytes: 6 * 1024 ** 3,
    usedMemoryBytes: 26 * 1024 ** 3,
    memoryPressureFreePercent: 72,
    swapins: 0,
    swapouts: 0,
    diskPath: '/',
    diskTotalBytes: 460 * 1024 ** 3,
    diskUsedBytes: 180 * 1024 ** 3,
    diskAvailableBytes: 280 * 1024 ** 3,
    diskCapacityPercent: 39,
    topPhysMemLine: '',
    cpuStatus: 'low',
    memoryStatus: 'low',
    diskStatus: 'low',
    overallPressure: 'low',
  };

  const chatServerProcesses = {
    chatServers: [
      {
        name: 'owner',
        label: 'com.chatserver.claude',
        kind: 'owner',
        port: 7690,
        localBaseUrl: 'http://127.0.0.1:7690',
        publicBaseUrl: '',
        instanceRoot: '',
        pid: 100,
        cpuPercent: 22,
        memPercent: 1,
        rssBytes: 320 * 1024 ** 2,
        elapsed: '00:10:00',
        command: 'node chat-server.mjs',
        listening: true,
      },
      {
        name: 'trial',
        label: 'com.chatserver.trial',
        kind: 'trial',
        port: 7696,
        localBaseUrl: 'http://127.0.0.1:7696',
        publicBaseUrl: 'https://trial.example.com',
        instanceRoot: join(tempHome, '.remotelab', 'instances', 'trial'),
        pid: 101,
        cpuPercent: 0.2,
        memPercent: 0.2,
        rssBytes: 80 * 1024 ** 2,
        elapsed: '01:00:00',
        command: 'node chat-server.mjs',
        listening: true,
      },
      {
        name: 'trial5',
        label: 'com.chatserver.trial5',
        kind: 'trial',
        port: 7700,
        localBaseUrl: 'http://127.0.0.1:7700',
        publicBaseUrl: 'https://trial5.example.com',
        instanceRoot: join(tempHome, '.remotelab', 'instances', 'trial5'),
        pid: 102,
        cpuPercent: 0.1,
        memPercent: 0.2,
        rssBytes: 72 * 1024 ** 2,
        elapsed: '01:00:00',
        command: 'node chat-server.mjs',
        listening: true,
      },
    ],
    totalCount: 3,
    runningCount: 3,
    totalRssBytes: (320 + 80 + 72) * 1024 ** 2,
  };

  const report = await collectLocalOpsReport({
    homeDir: tempHome,
    date: '2026-03-24',
    days: 1,
    nowMs: Date.parse('2026-03-24T12:00:00.000Z'),
    hostMetrics,
    chatServerProcesses,
    instanceStatusProbe: async (instance) => ({
      localReachable: true,
      publicReachable: instance.name === 'trial5' ? true : false,
    }),
  });

  assert.equal(report.trialSummary.totalCount, 2, 'should discover both trial services');
  assert.equal(report.trialSummary.activeInWindowCount, 2, 'should classify newly created or interacted trials as active');
  assert.equal(report.trialSummary.candidatePauseNames.length, 0, 'newly created waiting trials should not be pause candidates');
  assert.equal(report.productSummary.totalUserMessagesInWindow, 2, 'should count posted user messages in window');
  assert.equal(report.productSummary.totalSessionsCreatedInWindow, 2, 'should count new sessions in window');
  assert.equal(report.productSummary.highPriorityWaitingSessions[0], 'trial5 · Trial5 follow-up session', 'should surface waiting-user follow-up');

  const trial = report.trials.find((entry) => entry.name === 'trial');
  const trial5 = report.trials.find((entry) => entry.name === 'trial5');
  assert.equal(trial?.realApiRequestsInWindow, 4, 'non-health requests should be counted');
  assert.equal(trial?.sessionsCreatedInWindow, 1, 'new sessions should be counted within the window');
  assert.equal(trial?.userMessagesInWindow, 2, 'trial should count user messages in window');
  assert.equal(trial?.engagedSessionCountInWindow, 1, 'trial should track engaged sessions from message posts');
  assert.equal(trial?.totalUserMessageCount, 2, 'trial should include cumulative user message count from history');
  assert.equal(trial?.status, 'active', 'active trial should be marked active');
  assert.equal(trial5?.status, 'active', 'newly created waiting trial should still be marked active');
  assert.equal(trial5?.highPriorityWaitingSessionCount, 1, 'trial5 should expose waiting follow-up count');

  const summary = renderLocalOpsSummary(report);
  assert.doesNotMatch(summary, /product activity/i, 'summary should not prioritize product activity');
  assert.doesNotMatch(summary, /user messages/i, 'summary should not enumerate trial message counts');
  assert.doesNotMatch(summary, /trial5/i, 'summary should not enumerate individual trial names by default');
  assert.match(summary, /host pressure low/i, 'summary should still mention host pressure');
  assert.match(summary, /trial services: 2\/2 running/i, 'summary should mention trial service runtime counts');

  const sidecar = await generateLocalOpsSidecar({
    homeDir: tempHome,
    outputDir: join(tempHome, '.remotelab', 'reports', 'local-ops'),
    date: '2026-03-24',
    days: 1,
    nowMs: Date.parse('2026-03-24T12:00:00.000Z'),
    hostMetrics,
    chatServerProcesses,
    instanceStatusProbe: async (instance) => ({
      localReachable: true,
      publicReachable: instance.name === 'trial5' ? true : false,
    }),
  });

  assert.doesNotMatch(readFileSync(sidecar.markdownPath, 'utf8'), /## Product Signals/, 'markdown should not include product signals by default');
  assert.doesNotMatch(readFileSync(sidecar.markdownPath, 'utf8'), /trial5 · Trial5 follow-up session/, 'markdown should not surface follow-up session names by default');
  assert.doesNotMatch(readFileSync(sidecar.markdownPath, 'utf8'), /trial5 —/i, 'markdown should not enumerate individual trial services by default');
  assert.doesNotMatch(readFileSync(sidecar.markdownPath, 'utf8'), /user messages in window/i, 'markdown should not enumerate trial user-message counts by default');
  assert.match(readFileSync(sidecar.jsonPath, 'utf8'), /"candidatePauseNames": \[/, 'json sidecar should include pause candidates');

  console.log('test-local-ops-summary: ok');
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}
