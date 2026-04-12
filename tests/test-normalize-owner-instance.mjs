#!/usr/bin/env node
import assert from 'assert/strict';
import { spawnSync } from 'child_process';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { buildLaunchAgentPlist } from '../lib/guest-instance.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const sandboxHome = join(tmpdir(), `remotelab-owner-normalize-${Date.now()}`);

mkdirSync(join(sandboxHome, '.config', 'remotelab'), { recursive: true });
mkdirSync(join(sandboxHome, '.remotelab', 'memory'), { recursive: true });
mkdirSync(join(sandboxHome, 'Library', 'LaunchAgents'), { recursive: true });
mkdirSync(join(sandboxHome, 'Library', 'Logs'), { recursive: true });

const plistPath = join(sandboxHome, 'Library', 'LaunchAgents', 'com.chatserver.claude.plist');
writeFileSync(plistPath, buildLaunchAgentPlist({
  label: 'com.chatserver.claude',
  nodePath: '/usr/local/bin/node',
  chatServerPath: '/Users/example/code/remotelab/chat-server.mjs',
  workingDirectory: sandboxHome,
  standardOutPath: join(sandboxHome, 'Library', 'Logs', 'chat-server.log'),
  standardErrorPath: join(sandboxHome, 'Library', 'Logs', 'chat-server.error.log'),
  environmentVariables: {
    CHAT_BIND_HOST: '0.0.0.0',
    SECURE_COOKIES: '0',
  },
}), 'utf8');

try {
  const dryRun = spawnSync('node', ['scripts/normalize-owner-instance.mjs', '--dry-run', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: sandboxHome,
    },
  });
  assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
  const dryRunOutput = JSON.parse(dryRun.stdout);
  assert.equal(dryRunOutput.ownerInstanceRoot, join(sandboxHome, '.remotelab', 'instances', 'owner'));
  assert.equal(dryRunOutput.aliases.length, 2);
  assert.equal(dryRunOutput.aliases.every((entry) => entry.changed === true), true);
  assert.equal(dryRunOutput.plistChanged, true);

  const apply = spawnSync('node', ['scripts/normalize-owner-instance.mjs', '--no-restart', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: sandboxHome,
    },
  });
  assert.equal(apply.status, 0, apply.stderr || apply.stdout);
  const applyOutput = JSON.parse(apply.stdout);
  assert.equal(applyOutput.restarted, false);

  const ownerRoot = join(sandboxHome, '.remotelab', 'instances', 'owner');
  assert.equal(realpathSync(join(ownerRoot, 'config')), realpathSync(join(sandboxHome, '.config', 'remotelab')));
  assert.equal(realpathSync(join(ownerRoot, 'memory')), realpathSync(join(sandboxHome, '.remotelab', 'memory')));

  const rewrittenPlist = readFileSync(plistPath, 'utf8');
  assert.match(rewrittenPlist, /<key>REMOTELAB_INSTANCE_ROOT<\/key><string>.*\.remotelab\/instances\/owner<\/string>/);
  assert.match(rewrittenPlist, /<key>CHAT_PORT<\/key><string>7690<\/string>/);
  assert.match(rewrittenPlist, /<key>HOME<\/key><string>/);
  assert.match(rewrittenPlist, /<key>REMOTELAB_SESSION_DISPATCH<\/key><string>on<\/string>/);
  assert.match(rewrittenPlist, /<key>REMOTELAB_USER_SHELL_ENV_B64<\/key><string>/);
} finally {
  rmSync(sandboxHome, { recursive: true, force: true });
}

console.log('test-normalize-owner-instance: ok');
