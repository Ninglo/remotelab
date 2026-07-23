#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  buildFeishuBotRestartPlan,
  discoverFeishuBots,
  findFeishuBot,
  parseFeishuConnectorProcessRows,
  parseFeishuLaunchdPlist,
  parseFeishuSystemdShow,
} from '../lib/feishu-bot-registry.mjs';

const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-feishu-bot-registry-'));

try {
  const configDir = join(tempHome, '.config', 'remotelab');
  const defaultConfigPath = join(configDir, 'feishu-connector', 'config.json');
  const botsRoot = join(configDir, 'feishu-connectors');
  const botBConfigPath = join(botsRoot, 'bot-b', 'config.json');
  const botBStorageDir = join(botsRoot, 'bot-b', 'state');
  const registryPath = join(configDir, 'feishu-bots.json');

  mkdirSync(join(configDir, 'feishu-connector'), { recursive: true });
  mkdirSync(join(botsRoot, 'bot-b'), { recursive: true });
  writeFileSync(defaultConfigPath, JSON.stringify({
    appId: 'cli_default_bot',
    appSecret: 'default-secret',
    region: 'feishu-cn',
    chatBaseUrl: 'http://127.0.0.1:7690',
  }, null, 2));
  writeFileSync(botBConfigPath, JSON.stringify({
    botId: 'bot-b',
    appId: 'cli_bot_b',
    appSecret: 'bot-b-secret',
    region: 'feishu-cn',
    chatBaseUrl: 'http://127.0.0.1:7690',
    storageDir: botBStorageDir,
  }, null, 2));

  const systemdFact = parseFeishuSystemdShow([
    'Id=remotelab-feishu-bot-b.service',
    'ActiveState=active',
    'SubState=running',
    'MainPID=2202',
    `ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node /opt/remotelab/scripts/feishu-connector.mjs --config ${botBConfigPath} ; }`,
    'Environment=HOME=/home/ubuntu',
  ].join('\n'), { defaultConfigPath });
  assert.equal(systemdFact.unit, 'remotelab-feishu-bot-b.service');
  assert.equal(systemdFact.configPath, botBConfigPath);
  assert.equal(systemdFact.pid, 2202);

  const launchdPlistPath = join(tempHome, 'Library', 'LaunchAgents', 'com.remotelab.feishu-connector.plist');
  const launchdFact = parseFeishuLaunchdPlist({
    Label: 'com.remotelab.feishu-connector',
    ProgramArguments: [
      '/usr/local/bin/node',
      '/opt/remotelab/scripts/feishu-connector.mjs',
    ],
    EnvironmentVariables: {
      HOME: tempHome,
    },
  }, [
    'state = running',
    'pid = 1101',
  ].join('\n'), {
    defaultConfigPath,
    plistPath: launchdPlistPath,
    uid: 501,
  });
  assert.equal(launchdFact.label, 'com.remotelab.feishu-connector');
  assert.equal(launchdFact.configPath, defaultConfigPath);
  assert.equal(launchdFact.pid, 1101);
  assert.equal(launchdFact.activeState, 'running');
  assert.equal(launchdFact.target, 'gui/501/com.remotelab.feishu-connector');

  const processFacts = parseFeishuConnectorProcessRows([
    '1101 node /opt/remotelab/scripts/feishu-connector.mjs',
    `2202 node /opt/remotelab/scripts/feishu-connector.mjs --config ${botBConfigPath}`,
    '3303 node /opt/remotelab/chat-server.mjs',
  ].join('\n'), { defaultConfigPath });
  assert.deepEqual(
    processFacts.map((fact) => ({ pid: fact.pid, configPath: fact.configPath })),
    [
      { pid: 1101, configPath: defaultConfigPath },
      { pid: 2202, configPath: botBConfigPath },
    ],
  );

  const registry = await discoverFeishuBots({
    configDir,
    defaultConfigPath,
    registryPath,
    processFacts,
    systemdFacts: [systemdFact],
    launchdFacts: [launchdFact],
    discoveredAt: '2026-07-23T12:00:00.000Z',
  });
  assert.equal(registry.version, 1);
  assert.equal(registry.bots.length, 2);
  const persistedRegistry = readFileSync(registryPath, 'utf8');
  assert.equal(JSON.parse(persistedRegistry).bots.length, 2);
  assert.doesNotMatch(persistedRegistry, /default-secret|bot-b-secret/);

  const defaultBot = findFeishuBot(registry, 'default');
  assert.ok(defaultBot);
  assert.equal(defaultBot.configPath, defaultConfigPath);
  assert.equal(defaultBot.runtime.kind, 'launchd');
  assert.equal(defaultBot.runtime.pid, 1101);

  const botB = findFeishuBot(registry, 'bot-b');
  assert.ok(botB);
  assert.equal(botB.storageDir, botBStorageDir);
  assert.equal(botB.runtime.kind, 'systemd');
  assert.equal(botB.runtime.unit, 'remotelab-feishu-bot-b.service');
  assert.equal(botB.runtime.pid, 2202);
  assert.equal(botB.status, 'running');
  assert.equal('appSecret' in botB, false, 'registry must not persist Bot secrets');

  assert.deepEqual(buildFeishuBotRestartPlan(botB, {
    helperPath: '/repo/scripts/feishu-connector-instance.sh',
  }), {
    kind: 'systemd',
    command: 'systemctl',
    args: ['restart', 'remotelab-feishu-bot-b.service'],
  });

  assert.deepEqual(buildFeishuBotRestartPlan(defaultBot, {
    helperPath: '/repo/scripts/feishu-connector-instance.sh',
  }), {
    kind: 'launchd',
    command: 'launchctl',
    args: ['kickstart', '-k', 'gui/501/com.remotelab.feishu-connector'],
    plistPath: launchdPlistPath,
  });

  assert.throws(
    () => buildFeishuBotRestartPlan({
      ...botB,
      status: 'ambiguous',
      issues: ['multiple_runtime_owners'],
    }, {
      helperPath: '/repo/scripts/feishu-connector-instance.sh',
    }),
    /ambiguous/i,
  );

  console.log('feishu bot registry tests passed');
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}
