#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const homeDir = mkdtempSync(join(tmpdir(), 'remotelab-natapp-dual-proxy-'));
const remotelabConfigDir = join(homeDir, '.config', 'remotelab');
const launchAgentsDir = join(homeDir, 'LaunchAgents');

mkdirSync(remotelabConfigDir, { recursive: true });
mkdirSync(launchAgentsDir, { recursive: true });

const trial4LaunchAgentPath = join(launchAgentsDir, 'com.chatserver.trial4.plist');
writeFileSync(trial4LaunchAgentPath, `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CHAT_PORT</key><string>7804</string>
  </dict>
</dict>
</plist>
`, 'utf8');

writeFileSync(join(remotelabConfigDir, 'guest-instances.json'), JSON.stringify([
  {
    name: 'trial4',
    port: 7699,
    localBaseUrl: 'http://127.0.0.1:7699',
    launchAgentPath: trial4LaunchAgentPath,
  },
  {
    name: 'trial7',
    port: 7712,
    localBaseUrl: 'http://127.0.0.1:7712',
  },
], null, 2), 'utf8');

process.env.HOME = homeDir;
delete process.env.NATAPP_PROXY_LISTEN_HOST;
delete process.env.NATAPP_PROXY_LISTEN_PORT;
delete process.env.NATAPP_ROOT_MODE;
delete process.env.NATAPP_ROOT_UPSTREAM_PORT;
process.env.NATAPP_BRIDGE_SERVICE_NAME = 'owner';
process.env.NATAPP_BRIDGE_SERVICE_PORT = '7690';

const proxy = await import(`../scripts/natapp-dual-proxy.mjs?test=${Date.now()}`);

try {
  assert.equal(proxy.ROOT_MODE, 'index', 'bridge root should default to a neutral index');

  const prefixedRoutes = await proxy.loadPrefixedRoutes();
  assert.ok(
    prefixedRoutes.some((route) => route.prefix === proxy.BRIDGE_SERVICE_PREFIX && route.upstreamPort === proxy.BRIDGE_SERVICE_UPSTREAM_PORT),
    'main service route should be part of the prefixed route table',
  );
  assert.ok(
    prefixedRoutes.some((route) => route.prefix === '/trial4' && route.upstreamPort === 7804),
    'prefixed routes should prefer the live launch-agent port when the guest registry drifted onto the proxy port',
  );

  assert.equal(
    await proxy.resolveRouteUpstreamPort({
      name: 'trial4',
      port: 7699,
      localBaseUrl: 'http://127.0.0.1:7699',
      launchAgentPath: trial4LaunchAgentPath,
    }),
    7804,
    'launch-agent CHAT_PORT should beat a stale registry record that points at the proxy listener',
  );

  const rootRoute = await proxy.mapRequest('/api/sessions');
  assert.equal(rootRoute, null, 'unprefixed bridge requests should no longer proxy an app surface by default');

  const ownerRoute = await proxy.mapRequest(`${proxy.BRIDGE_SERVICE_PREFIX}/api/sessions?view=all`);
  assert.equal(ownerRoute.prefixed, true);
  assert.equal(ownerRoute.prefix, proxy.BRIDGE_SERVICE_PREFIX);
  assert.equal(ownerRoute.cookiePrefix, 'owner__');
  assert.equal(ownerRoute.upstreamPort, proxy.BRIDGE_SERVICE_UPSTREAM_PORT);
  assert.equal(ownerRoute.upstreamPath, '/api/sessions?view=all');

  const trialRoute = await proxy.mapRequest('/trial4/api/build-info');
  assert.equal(trialRoute.prefixed, true);
  assert.equal(trialRoute.prefix, '/trial4');
  assert.equal(trialRoute.upstreamPort, 7804);
  assert.equal(trialRoute.upstreamPath, '/api/build-info');

  const trialCalendarRoute = await proxy.mapRequest('/trial4/cal/abc123.ics');
  assert.equal(trialCalendarRoute.prefixed, true);
  assert.equal(trialCalendarRoute.upstreamPath, '/cal/abc123.ics');

  const rewrittenCookie = proxy.rewriteSetCookieHeader(
    'session_token=abc123; HttpOnly; Path=/; SameSite=Lax',
    ownerRoute,
  );
  assert.equal(
    rewrittenCookie,
    `owner__session_token=abc123; Path=${proxy.BRIDGE_SERVICE_PREFIX}; HttpOnly; SameSite=Lax`,
  );

  const upstreamHeaders = proxy.buildUpstreamHeaders({
    cookie: 'owner__session_token=abc123; owner__visitor_session_token=def456; session_token=root-token',
    'x-test-header': 'ok',
  }, ownerRoute);
  assert.equal(upstreamHeaders.cookie, 'session_token=abc123; visitor_session_token=def456');
  assert.equal(upstreamHeaders['x-forwarded-prefix'], proxy.BRIDGE_SERVICE_PREFIX);
  assert.equal(upstreamHeaders['x-test-header'], 'ok');
  assert.equal(upstreamHeaders['accept-encoding'], 'identity');

  const bridgedOwnerHeaders = proxy.buildUpstreamHeaders({
    cookie: 'session_token=legacy-owner; visitor_session_token=legacy-visitor; trial4__session_token=trial-cookie',
  }, ownerRoute);
  assert.equal(bridgedOwnerHeaders.cookie, 'session_token=legacy-owner; visitor_session_token=legacy-visitor');
  assert.equal(bridgedOwnerHeaders['x-forwarded-prefix'], proxy.BRIDGE_SERVICE_PREFIX);

  const bridgedTrialHeaders = proxy.buildUpstreamHeaders({
    cookie: 'trial4__session_token=trial-cookie',
  }, trialRoute);
  assert.equal(bridgedTrialHeaders.cookie, 'session_token=trial-cookie');
  assert.equal(bridgedTrialHeaders['x-forwarded-prefix'], '/trial4');

  const rootIndex = await proxy.renderRootIndexHtml();
  assert.match(rootIndex, /prefix-only/i, 'root index should explain the prefix-only bridge rule');
  assert.match(rootIndex, /\/owner\//, 'root index should list the main service prefix');
  assert.match(rootIndex, /\/trial4\//, 'root index should list the repaired trial4 prefix');

  console.log('test-natapp-dual-proxy: ok');
} finally {
  rmSync(homeDir, { recursive: true, force: true });
}
