#!/usr/bin/env node
import assert from 'assert/strict';

delete process.env.NATAPP_PROXY_LISTEN_HOST;
delete process.env.NATAPP_PROXY_LISTEN_PORT;
delete process.env.NATAPP_ROOT_UPSTREAM_PORT;
delete process.env.NATAPP_OWNER_UPSTREAM_PORT;
delete process.env.NATAPP_OWNER_ROUTE_PREFIX;

const proxy = await import('../scripts/natapp-dual-proxy.mjs');

assert.ok(
  proxy.loadPrefixedRoutes().some((route) => route.prefix === proxy.OWNER_ROUTE_PREFIX && route.upstreamPort === proxy.OWNER_UPSTREAM_PORT),
  'owner route should be part of the prefixed route table',
);

const rootRoute = proxy.mapRequest('/api/sessions');
assert.deepEqual(rootRoute, {
  prefixed: false,
  prefix: '',
  cookiePrefix: '',
  upstreamPort: proxy.ROOT_UPSTREAM_PORT,
  upstreamPath: '/api/sessions',
});
assert.equal(proxy.ROOT_UPSTREAM_PORT, 7804, 'root upstream should preserve the historical mainland root target');

const ownerRoute = proxy.mapRequest(`${proxy.OWNER_ROUTE_PREFIX}/api/sessions?view=all`);
assert.equal(ownerRoute.prefixed, true);
assert.equal(ownerRoute.prefix, proxy.OWNER_ROUTE_PREFIX);
assert.equal(ownerRoute.cookiePrefix, 'owner__');
assert.equal(ownerRoute.upstreamPort, proxy.OWNER_UPSTREAM_PORT);
assert.equal(ownerRoute.upstreamPath, '/api/sessions?view=all');

const rewrittenCookie = proxy.rewriteSetCookieHeader(
  'session_token=abc123; HttpOnly; Path=/; SameSite=Lax',
  ownerRoute,
);
assert.equal(
  rewrittenCookie,
  `owner__session_token=abc123; Path=${proxy.OWNER_ROUTE_PREFIX}; HttpOnly; SameSite=Lax`,
);

const upstreamHeaders = proxy.buildUpstreamHeaders({
  cookie: 'owner__session_token=abc123; owner__visitor_session_token=def456; session_token=root-token',
  'x-test-header': 'ok',
}, ownerRoute);
assert.equal(upstreamHeaders.cookie, 'session_token=abc123; visitor_session_token=def456');
assert.equal(upstreamHeaders['x-test-header'], 'ok');
assert.equal(upstreamHeaders['accept-encoding'], 'identity');

const bridgedOwnerHeaders = proxy.buildUpstreamHeaders({
  cookie: 'session_token=legacy-owner; visitor_session_token=legacy-visitor; trial4__session_token=trial-cookie',
}, ownerRoute);
assert.equal(bridgedOwnerHeaders.cookie, 'session_token=legacy-owner; visitor_session_token=legacy-visitor');

console.log('test-natapp-dual-proxy: ok');
