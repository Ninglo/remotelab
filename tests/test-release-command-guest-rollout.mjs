#!/usr/bin/env node
import assert from 'assert/strict';
import http from 'http';
import { execFileSync } from 'child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { buildLaunchAgentPlist } from '../lib/guest-instance.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

function randomPort() {
  return 44000 + Math.floor(Math.random() * 10000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, timeoutMs = 20000, intervalMs = 150) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out: ${description}`);
}

function request(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'GET',
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode, text: data });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function waitForBuildInfo(port, expectation, timeoutMs = 20000) {
  return waitFor(async () => {
    try {
      const response = await request(port, '/api/build-info');
      if (response.status !== 200) return null;
      const buildInfo = JSON.parse(response.text);
      if (expectation.runtimeMode && buildInfo.runtimeMode !== expectation.runtimeMode) {
        return null;
      }
      if (Object.prototype.hasOwnProperty.call(expectation, 'releaseId')) {
        const actualReleaseId = String(buildInfo.releaseId || '');
        const expectedReleaseId = expectation.releaseId === null ? '' : String(expectation.releaseId || '');
        if (actualReleaseId !== expectedReleaseId) {
          return null;
        }
      }
      const loginResponse = await request(port, '/login');
      if (loginResponse.status !== 200) return null;
      return buildInfo;
    } catch {
      return null;
    }
  }, `build info on port ${port}`, timeoutMs, 250);
}

function writeAuthConfig(configDir, token) {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'auth.json'), `${JSON.stringify({ token }, null, 2)}\n`, 'utf8');
  writeFileSync(join(configDir, 'auth-sessions.json'), '{}\n', 'utf8');
}

function writeFakeLaunchctl(binDir, stateDir) {
  mkdirSync(binDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  const scriptPath = join(binDir, 'launchctl');
  writeFileSync(scriptPath, `#!/usr/bin/env node
const { spawn } = require('child_process');
const { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } = require('fs');
const { basename, join } = require('path');

const stateDir = ${JSON.stringify(stateDir)};
mkdirSync(stateDir, { recursive: true });

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
}

function extractString(content, key) {
  const match = String(content || '').match(new RegExp('<key>' + escapeRegex(key) + '</key>\\\\s*<string>([\\\\s\\\\S]*?)</string>'));
  return decodeXmlEntities(match && match[1] ? match[1] : '');
}

function extractArray(content, key) {
  const match = String(content || '').match(new RegExp('<key>' + escapeRegex(key) + '</key>\\\\s*<array>([\\\\s\\\\S]*?)</array>'));
  if (!match) return [];
  return Array.from(match[1].matchAll(/<string>([\\s\\S]*?)<\\/string>/g)).map((entry) => decodeXmlEntities(entry[1] || ''));
}

function extractDict(content, key) {
  const match = String(content || '').match(new RegExp('<key>' + escapeRegex(key) + '</key>\\\\s*<dict>([\\\\s\\\\S]*?)</dict>'));
  if (!match) return {};
  const dict = {};
  for (const entry of match[1].matchAll(/<key>([\\s\\S]*?)<\\/key>\\s*<string>([\\s\\S]*?)<\\/string>/g)) {
    const dictKey = decodeXmlEntities(entry[1] || '');
    if (!dictKey) continue;
    dict[dictKey] = decodeXmlEntities(entry[2] || '');
  }
  return dict;
}

function pidFile(label) {
  return join(stateDir, label + '.pid');
}

function plistFile(label) {
  return join(stateDir, label + '.plist-path');
}

function isRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(label) {
  try {
    const pid = Number.parseInt(readFileSync(pidFile(label), 'utf8').trim(), 10);
    return Number.isInteger(pid) ? pid : 0;
  } catch {
    return 0;
  }
}

function stopLabel(label) {
  const pid = readPid(label);
  if (isRunning(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
    }
  }
  rmSync(pidFile(label), { force: true });
}

function startFromPlist(plistPath) {
  const content = readFileSync(plistPath, 'utf8');
  const label = trimString(extractString(content, 'Label')) || trimString(basename(plistPath).replace(/\\.plist$/, ''));
  const programArguments = extractArray(content, 'ProgramArguments');
  const environmentVariables = extractDict(content, 'EnvironmentVariables');
  const workingDirectory = trimString(extractString(content, 'WorkingDirectory')) || process.cwd();
  if (programArguments.length === 0) {
    throw new Error('ProgramArguments missing for ' + plistPath);
  }
  stopLabel(label);
  const child = spawn(programArguments[0], programArguments.slice(1), {
    cwd: workingDirectory,
    detached: true,
    env: {
      ...process.env,
      ...environmentVariables,
    },
    stdio: 'ignore',
  });
  child.unref();
  writeFileSync(pidFile(label), String(child.pid), 'utf8');
  writeFileSync(plistFile(label), plistPath, 'utf8');
}

const [, , command, arg] = process.argv;

if (command === 'load') {
  startFromPlist(arg);
  process.exit(0);
}

if (command === 'unload') {
  const label = trimString(basename(arg || '').replace(/\\.plist$/, ''));
  stopLabel(label);
  process.exit(0);
}

if (command === 'stop') {
  const label = trimString(arg || '');
  let plistPath = '';
  try {
    plistPath = trimString(readFileSync(plistFile(label), 'utf8'));
  } catch {
    plistPath = '';
  }
  stopLabel(label);
  if (plistPath) {
    startFromPlist(plistPath);
  }
  process.exit(0);
}

if (command === 'list') {
  const lines = [];
  for (const entry of readdirSync(stateDir)) {
    if (!entry.endsWith('.pid')) continue;
    const label = entry.slice(0, -4);
    const pid = readPid(label);
    if (isRunning(pid)) {
      lines.push(pid + '\\t0\\t' + label);
    } else {
      rmSync(pidFile(label), { force: true });
    }
  }
  process.stdout.write(lines.join('\\n'));
  process.exit(0);
}

process.exit(1);
`, 'utf8');
  chmodSync(scriptPath, 0o755);

  const unamePath = join(binDir, 'uname');
  writeFileSync(unamePath, '#!/bin/sh\necho Darwin\n', 'utf8');
  chmodSync(unamePath, 0o755);
}

function readLabelPid(stateDir, label) {
  const path = join(stateDir, `${label}.pid`);
  return Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
}

async function main() {
  const sandboxHome = mkdtempSync(join(tmpdir(), 'remotelab-release-rollout-'));
  const binDir = join(sandboxHome, 'bin');
  const stateDir = join(sandboxHome, '.fake-launchctl');
  const launchAgentsDir = join(sandboxHome, 'Library', 'LaunchAgents');
  const logDir = join(sandboxHome, 'Library', 'Logs');
  const activeReleaseFile = join(sandboxHome, '.config', 'remotelab', 'active-release.test.json');
  const ownerPort = randomPort();
  const guestPorts = [ownerPort + 1, ownerPort + 2];
  const guests = [
    { name: 'trial-alpha', port: guestPorts[0] },
    { name: 'trial-beta', port: guestPorts[1] },
  ];

  mkdirSync(launchAgentsDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  mkdirSync(join(sandboxHome, '.config', 'remotelab'), { recursive: true });
  mkdirSync(join(sandboxHome, '.remotelab', 'memory'), { recursive: true });
  writeFakeLaunchctl(binDir, stateDir);
  writeAuthConfig(join(sandboxHome, '.config', 'remotelab'), 'owner-test-token');

  const ownerPlist = join(launchAgentsDir, 'com.chatserver.claude.plist');
  writeFileSync(ownerPlist, buildLaunchAgentPlist({
    label: 'com.chatserver.claude',
    nodePath: process.execPath,
    chatServerPath: join(repoRoot, 'chat-server.mjs'),
    workingDirectory: repoRoot,
    standardOutPath: join(logDir, 'chat-server-owner.log'),
    standardErrorPath: join(logDir, 'chat-server-owner.error.log'),
    environmentVariables: {
      CHAT_BIND_HOST: '127.0.0.1',
      CHAT_PORT: String(ownerPort),
      HOME: sandboxHome,
      REMOTELAB_ACTIVE_RELEASE_FILE: activeReleaseFile,
      REMOTELAB_ENABLE_ACTIVE_RELEASE: '1',
      SECURE_COOKIES: '0',
    },
  }), 'utf8');

  const guestPlists = [];
  for (const guest of guests) {
    const instanceRoot = join(sandboxHome, '.remotelab', 'instances', guest.name);
    writeAuthConfig(join(instanceRoot, 'config'), `${guest.name}-token`);
    mkdirSync(join(instanceRoot, 'memory'), { recursive: true });
    const plistPath = join(launchAgentsDir, `com.chatserver.${guest.name}.plist`);
    writeFileSync(plistPath, buildLaunchAgentPlist({
      label: `com.chatserver.${guest.name}`,
      nodePath: process.execPath,
      chatServerPath: join(repoRoot, 'chat-server.mjs'),
      workingDirectory: repoRoot,
      standardOutPath: join(logDir, `chat-server-${guest.name}.log`),
      standardErrorPath: join(logDir, `chat-server-${guest.name}.error.log`),
      environmentVariables: {
        CHAT_BIND_HOST: '127.0.0.1',
        CHAT_PORT: String(guest.port),
        HOME: sandboxHome,
        REMOTELAB_ACTIVE_RELEASE_FILE: activeReleaseFile,
        REMOTELAB_ENABLE_ACTIVE_RELEASE: '1',
        REMOTELAB_INSTANCE_ROOT: instanceRoot,
        SECURE_COOKIES: '0',
      },
    }), 'utf8');
    guestPlists.push(plistPath);
  }

  const commandEnv = {
    ...process.env,
    HOME: sandboxHome,
    PATH: `${binDir}:${process.env.PATH}`,
    REMOTELAB_ACTIVE_RELEASE_FILE: activeReleaseFile,
  };

  let snapshotRoot = '';
  try {
    execFileSync('launchctl', ['load', ownerPlist], { env: commandEnv, stdio: 'inherit' });
    for (const plistPath of guestPlists) {
      execFileSync('launchctl', ['load', plistPath], { env: commandEnv, stdio: 'inherit' });
    }

    await waitForBuildInfo(ownerPort, { runtimeMode: 'source', releaseId: null });
    for (const guest of guests) {
      await waitForBuildInfo(guest.port, { runtimeMode: 'source', releaseId: null });
    }

    const ownerPidBefore = readLabelPid(stateDir, 'com.chatserver.claude');
    const guestPidsBefore = Object.fromEntries(
      guests.map((guest) => [guest.name, readLabelPid(stateDir, `com.chatserver.${guest.name}`)]),
    );

    const releaseResult = execFileSync(
      process.execPath,
      ['cli.js', 'release', '--skip-tests', '--base-url', `http://127.0.0.1:${ownerPort}`, '--timeout-ms', '30000'],
      {
        cwd: repoRoot,
        env: commandEnv,
        encoding: 'utf8',
      },
    );
    assert.match(releaseResult, /Release .* is active/);
    assert.ok(existsSync(activeReleaseFile), 'release activation should write the active release manifest');
    const manifest = JSON.parse(readFileSync(activeReleaseFile, 'utf8'));
    snapshotRoot = manifest.snapshotRoot;
    assert.ok(manifest.releaseId, 'release manifest should record a release id');

    const ownerBuildInfo = await waitForBuildInfo(ownerPort, { runtimeMode: 'release', releaseId: manifest.releaseId }, 30000);
    assert.equal(ownerBuildInfo.releaseId, manifest.releaseId);

    for (const guest of guests) {
      const guestBuildInfo = await waitForBuildInfo(guest.port, { runtimeMode: 'release', releaseId: manifest.releaseId }, 30000);
      assert.equal(guestBuildInfo.releaseId, manifest.releaseId);
    }

    const ownerPidAfter = readLabelPid(stateDir, 'com.chatserver.claude');
    assert.notEqual(ownerPidAfter, ownerPidBefore, 'owner service should restart during release');
    for (const guest of guests) {
      const guestPidAfter = readLabelPid(stateDir, `com.chatserver.${guest.name}`);
      assert.notEqual(guestPidAfter, guestPidsBefore[guest.name], `${guest.name} should restart during release`);
    }

    console.log('test-release-command-guest-rollout: ok');
  } finally {
    for (const plistPath of [ownerPlist, ...guestPlists]) {
      try {
        execFileSync('launchctl', ['unload', plistPath], { env: commandEnv, stdio: 'ignore' });
      } catch {
      }
    }
    if (snapshotRoot) {
      rmSync(snapshotRoot, { recursive: true, force: true });
    }
    rmSync(activeReleaseFile, { force: true });
    rmSync(sandboxHome, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('test-release-command-guest-rollout: failed');
  console.error(error);
  process.exitCode = 1;
});
