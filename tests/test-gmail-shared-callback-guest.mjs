#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const repoRoot = process.cwd();
const tempSystemHome = mkdtempSync(join(tmpdir(), 'remotelab-gmail-shared-callback-'));
const guestRoot = join(tempSystemHome, 'guests', 'trial8');
const configDir = join(guestRoot, 'config');
const guestDefaultsPath = join(tempSystemHome, '.config', 'remotelab', 'guest-instance-defaults.json');

process.env.HOME = guestRoot;
process.env.REMOTELAB_INSTANCE_ROOT = guestRoot;
process.env.REMOTELAB_CONFIG_DIR = configDir;
process.env.REMOTELAB_PUBLIC_BASE_URL = 'https://trial8.jiujianian-dev-world.win';
process.env.REMOTELAB_SYSTEM_HOME = tempSystemHome;

mkdirSync(configDir, { recursive: true });
mkdirSync(join(guestDefaultsPath, '..'), { recursive: true });
writeFileSync(guestDefaultsPath, JSON.stringify({
  publicDomain: 'jiujianian-dev-world.win',
  bridgeBaseUrlTemplate: 'https://{name}.jiujianian-dev-world.win',
}, null, 2), 'utf8');

const routerModule = await import(pathToFileURL(join(repoRoot, 'chat', 'router-connector-routes.mjs')).href);

try {
  const redirectUri = await routerModule.__testing.resolveGmailAuthRedirectUri({
    headers: {
      host: 'trial8.jiujianian-dev-world.win',
      'x-forwarded-proto': 'https',
    },
  });
  assert.equal(
    redirectUri,
    'https://owner.jiujianian-dev-world.win/api/connectors/gmail/google/callback',
    'guest instances should use the shared owner callback URI for Gmail OAuth',
  );
  console.log('test-gmail-shared-callback-guest: ok');
} finally {
  rmSync(tempSystemHome, { recursive: true, force: true });
}
