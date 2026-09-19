#!/usr/bin/env node
import assert from 'node:assert/strict';

import { buildCodexArgs, resolveCodexConfigOverrides } from '../chat/adapters/codex.mjs';

const proxied = {
  HTTPS_PROXY: 'http://127.0.0.1:18082',
  REMOTELAB_CODEX_CONFIG_OVERRIDES_JSON: '["check_for_update_on_startup=false"]',
  REMOTELAB_QUICK_CODEX_CONFIG_OVERRIDES_JSON: '["model_catalog_json=\\"/tmp/models.json\\"","mcp_servers.openaiDeveloperDocs.enabled=false"]',
};

assert.deepEqual(resolveCodexConfigOverrides({}, proxied), [
  'features.respect_system_proxy=true',
  'suppress_unstable_features_warning=true',
  'check_for_update_on_startup=false',
]);
assert.deepEqual(resolveCodexConfigOverrides({ executionProfile: 'quick' }, proxied), [
  'features.respect_system_proxy=true',
  'suppress_unstable_features_warning=true',
  'check_for_update_on_startup=false',
  'model_catalog_json="/tmp/models.json"',
  'mcp_servers.openaiDeveloperDocs.enabled=false',
]);
assert.deepEqual(resolveCodexConfigOverrides({}, {
  HTTPS_PROXY: 'http://127.0.0.1:18082',
  REMOTELAB_CODEX_RESPECT_SYSTEM_PROXY: 'false',
}), []);
assert.throws(
  () => resolveCodexConfigOverrides({}, { REMOTELAB_CODEX_CONFIG_OVERRIDES_JSON: '{}' }),
  /JSON array/,
);

const previousProxy = process.env.HTTPS_PROXY;
const previousOverrides = process.env.REMOTELAB_CODEX_CONFIG_OVERRIDES_JSON;
try {
  process.env.HTTPS_PROXY = 'http://127.0.0.1:18082';
  process.env.REMOTELAB_CODEX_CONFIG_OVERRIDES_JSON = '["check_for_update_on_startup=false"]';
  const args = buildCodexArgs('hello', {
    codexConfigOverrides: ['model_catalog_json="/tmp/models.json"'],
  });
  assert.deepEqual(
    args.filter((value, index) => args[index - 1] === '-c'),
    [
      'features.respect_system_proxy=true',
      'suppress_unstable_features_warning=true',
      'check_for_update_on_startup=false',
      'model_catalog_json="/tmp/models.json"',
    ],
  );
} finally {
  if (previousProxy === undefined) delete process.env.HTTPS_PROXY;
  else process.env.HTTPS_PROXY = previousProxy;
  if (previousOverrides === undefined) delete process.env.REMOTELAB_CODEX_CONFIG_OVERRIDES_JSON;
  else process.env.REMOTELAB_CODEX_CONFIG_OVERRIDES_JSON = previousOverrides;
}

console.log('test-codex-config-overrides: ok');
