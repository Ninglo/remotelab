#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

function runCli(args, env) {
  return spawnSync(process.execPath, ['cli.js', 'agenda', ...args], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
}

const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-agenda-command-'));
const configDir = join(tempHome, '.config', 'remotelab');
mkdirSync(configDir, { recursive: true });

const env = {
  ...process.env,
  HOME: tempHome,
  REMOTELAB_CONFIG_DIR: configDir,
  REMOTELAB_MEMORY_DIR: join(tempHome, '.remotelab', 'memory'),
  REMOTELAB_PUBLIC_BASE_URL: 'https://trial23.example.com',
};

try {
  const add = runCli([
    'add',
    '--title', 'Team standup',
    '--start', '2026-05-01T10:00:00+08:00',
    '--duration', '30',
    '--description', 'Daily sync',
    '--reminder', '5',
    '--json',
  ], env);
  assert.equal(add.status, 0, add.stderr);
  const addJson = JSON.parse(add.stdout);
  assert.equal(addJson.event.summary, 'Team standup');
  assert.equal(addJson.event.description, 'Daily sync');
  assert.deepEqual(addJson.event.reminders, [5]);
  assert.match(addJson.subscribe.subscriptionUrl, /^https:\/\/trial23\.example\.com\/cal\/[a-f0-9]+\.ics$/);

  const help = runCli(['--help'], env);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /remotelab agenda <command> \[options\]/);

  const list = runCli(['list', '--json'], env);
  assert.equal(list.status, 0, list.stderr);
  const listJson = JSON.parse(list.stdout);
  assert.equal(listJson.events.length, 1);
  assert.equal(listJson.events[0].summary, 'Team standup');

  const eventId = addJson.event.uid;
  const update = runCli([
    'update',
    eventId,
    '--title', 'Team standup (updated)',
    '--duration', '45',
    '--json',
  ], env);
  assert.equal(update.status, 0, update.stderr);
  const updateJson = JSON.parse(update.stdout);
  assert.equal(updateJson.event.summary, 'Team standup (updated)');

  const subscribe = runCli(['subscribe', '--json'], env);
  assert.equal(subscribe.status, 0, subscribe.stderr);
  const subscribeJson = JSON.parse(subscribe.stdout);
  assert.equal(subscribeJson.subscribe.helperPath, '/subscribe/calendar');
  assert.equal(subscribeJson.subscribe.manualHelperPath, '/subscribe/calendar?format=https');
  assert.match(subscribeJson.subscribe.subscriptionUrl, /^https:\/\/trial23\.example\.com\/cal\/[a-f0-9]+\.ics$/);

  const remove = runCli(['delete', eventId, '--json'], env);
  assert.equal(remove.status, 0, remove.stderr);
  const removeJson = JSON.parse(remove.stdout);
  assert.equal(removeJson.deleted, true);
  assert.equal(removeJson.eventId, eventId);

  console.log('test-agenda-command: ok');
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}
