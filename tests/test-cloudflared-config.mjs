#!/usr/bin/env node
import assert from 'assert/strict';
import { parseCloudflaredIngress, selectCloudflaredAccessDomain } from './lib/cloudflared-config.mjs';

const baseConfig = `tunnel: claude-code-remote
credentials-file: /Users/example/.cloudflared/example-tunnel.json
protocol: http2

ingress:
  - hostname: legacy.example.com
    service: http://127.0.0.1:7690
  - hostname: secondary.example.com
    service: http://127.0.0.1:7688
  - service: http_status:404
`;

const dualProdConfig = `tunnel: claude-code-remote
credentials-file: /Users/example/.cloudflared/example-tunnel.json
protocol: http2

ingress:
  - hostname: chat.example.com
    service: http://127.0.0.1:7690
  - hostname: legacy.example.com
    service: http://127.0.0.1:7690
  - hostname: secondary.example.com
    service: http://127.0.0.1:7688
  - service: http_status:404
`;

const remotelabFallbackConfig = `tunnel: claude-code-remote
credentials-file: /Users/example/.cloudflared/example-tunnel.json
protocol: http2

ingress:
  - hostname: legacy.example.com
    service: http://127.0.0.1:7690
  - hostname: remotelab.example.com
    service: http://127.0.0.1:7690
  - service: http_status:404
`;

assert.deepEqual(parseCloudflaredIngress(baseConfig), [
  {
    hostname: 'legacy.example.com',
    service: 'http://127.0.0.1:7690',
  },
  {
    hostname: 'secondary.example.com',
    service: 'http://127.0.0.1:7688',
  },
]);

assert.equal(
  await selectCloudflaredAccessDomain(baseConfig, {
    hostnameResolves: async (hostname) => hostname === 'legacy.example.com',
  }),
  'legacy.example.com'
);

assert.equal(
  await selectCloudflaredAccessDomain(dualProdConfig, {
    hostnameResolves: async (hostname) => hostname === 'legacy.example.com',
  }),
  'legacy.example.com'
);

assert.equal(
  await selectCloudflaredAccessDomain(dualProdConfig, {
    hostnameResolves: async (hostname) => [
      'chat.example.com',
      'legacy.example.com',
    ].includes(hostname),
  }),
  'chat.example.com'
);

assert.equal(
  await selectCloudflaredAccessDomain('ingress:\n  - hostname: other.example.com\n    service: http://127.0.0.1:7688\n', {
    hostnameResolves: async () => true,
  }),
  null
);

assert.equal(
  await selectCloudflaredAccessDomain(remotelabFallbackConfig, {
    hostnameResolves: async () => {
      throw new Error('dns unavailable');
    },
  }),
  'remotelab.example.com'
);

console.log('test-cloudflared-config: ok');
