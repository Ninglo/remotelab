#!/usr/bin/env node
import assert from 'assert/strict';

import {
  buildClientInstanceSettings,
  normalizeInstanceSettings,
} from '../chat/instance-settings.mjs';

const legacySettings = normalizeInstanceSettings({
  voiceInput: {
    appId: 'legacy-app',
    accessToken: 'legacy-token',
    resourceId: 'volc.seedasr.sauc.duration',
    language: 'en-US',
  },
});

assert.equal(legacySettings.voiceInput.provider, 'doubao');
assert.equal(legacySettings.voiceInput.configured, true);
assert.equal(legacySettings.voiceInput.clientReady, true);
assert.equal(legacySettings.voiceInput.language, 'en-US');

const directSettings = normalizeInstanceSettings({
  voiceInput: {
    provider: 'doubao_gateway_direct',
    gatewayApiKey: 'gateway-key-live',
    gatewayUrl: 'wss://ai-gateway.vei.volces.com/v1/realtime',
    gatewayModel: 'bigmodel',
    language: 'zh-CN',
  },
});

assert.equal(directSettings.voiceInput.provider, 'doubao_gateway_direct');
assert.equal(directSettings.voiceInput.configured, true);
assert.equal(directSettings.voiceInput.clientReady, true);
assert.equal(directSettings.voiceInput.gatewayApiKey, 'gateway-key-live');

const ownerView = buildClientInstanceSettings(directSettings, {
  authSession: { role: 'owner' },
});
assert.equal(ownerView.voiceInput.gatewayApiKey, 'gateway-key-live');
assert.equal(ownerView.voiceInput.clientReady, true);

const visitorView = buildClientInstanceSettings(directSettings, {
  authSession: { role: 'visitor' },
});
assert.equal(visitorView.voiceInput.gatewayApiKey, '', 'visitor view should redact gateway secrets');
assert.equal(visitorView.voiceInput.configured, true, 'visitor view should still expose service readiness');
assert.equal(visitorView.voiceInput.clientReady, false, 'visitor view should not advertise direct-browser readiness without the key');

console.log('test-chat-instance-settings: ok');
