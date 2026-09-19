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

const alphaView = buildClientInstanceSettings(directSettings, {
  authSession: { personId: 'person_alpha', identityId: 'identity_web_alpha' },
});
assert.equal(alphaView.voiceInput.gatewayApiKey, 'gateway-key-live');
assert.equal(alphaView.voiceInput.clientReady, true);

const betaView = buildClientInstanceSettings(directSettings, {
  authSession: { personId: 'person_beta', identityId: 'identity_web_beta' },
});
assert.equal(betaView.voiceInput.gatewayApiKey, 'gateway-key-live', 'every authenticated Person has complete instance access');
assert.equal(betaView.voiceInput.clientReady, true);

const anonymousView = buildClientInstanceSettings(directSettings);
assert.equal(anonymousView.voiceInput.gatewayApiKey, '', 'anonymous bootstrap data must redact gateway secrets');
assert.equal(anonymousView.voiceInput.clientReady, false);

console.log('test-chat-instance-settings: ok');
