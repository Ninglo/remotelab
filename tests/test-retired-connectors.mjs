#!/usr/bin/env node
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { buildSourceRuntimePrompt } from '../chat/source-runtime-prompts.mjs';

const root = new URL('../', import.meta.url);
for (const path of [
  'scripts/whatsapp-business-connector.mjs', 'scripts/whatsapp-business-connector-instance.sh',
  'scripts/voice-connector.mjs', 'scripts/voice-connector-instance.sh',
  'scripts/voice-connector-remotelab.mjs', 'scripts/voice-connector-shell.mjs',
  'docs/voice-connector.md', 'docs/whatsapp-business-setup.md',
]) {
  await assert.rejects(access(new URL(path, root)), { code: 'ENOENT' }, `${path} must remain retired`);
}
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
for (const command of ['whatsapp:connect', 'whatsapp:connect:instance', 'voice:connect', 'voice:connect:instance']) {
  assert.equal(pkg.scripts[command], undefined);
}
const router = await readFile(new URL('chat/router-connector-routes.mjs', root), 'utf8');
assert.doesNotMatch(router, /ensureWhatsAppBusinessConnectorSurfaceRunning|WHATSAPP_BUSINESS_CONNECTOR/);
for (const sourceId of ['voice', 'whatsapp', 'whatsapp-business']) {
  assert.equal(buildSourceRuntimePrompt({ sourceId }), '', `${sourceId} must not retain a built-in runtime policy`);
}
assert.match(buildSourceRuntimePrompt({ sourceId: 'shortcut' }), /Shortcuts/);
for (const path of ['chat/voice-doubao-relay.mjs', 'static/chat/voice-input.js', 'chat/bootstrap-assets/remotelab-voice.shortcut']) {
  await access(new URL(path, root));
}
console.log('retired connectors: no WA/Voice runtime or launcher; browser voice and Shortcut remain supported');
