#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const composerStoreSource = readFileSync(join(repoRoot, 'static', 'chat', 'composer-store.js'), 'utf8');
const composeSource = readFileSync(join(repoRoot, 'static', 'chat', 'compose.js'), 'utf8');
const uiSource = readFileSync(join(repoRoot, 'static', 'chat', 'ui.js'), 'utf8');
const cssSource = readFileSync(join(repoRoot, 'static', 'chat', 'chat-messages.css'), 'utf8');
const i18nSource = readFileSync(join(repoRoot, 'static', 'chat', 'i18n.js'), 'utf8');

assert.match(
  composerStoreSource,
  /rawPendingSend\.stage === "checking"/,
  'composer store should preserve the checking stage instead of collapsing it back to sending',
);

assert.match(
  composerStoreSource,
  /pendingSend\.stage !== "processing" && pendingSend\.stage !== "checking"/,
  'composer store should treat checking as non-blocking composer state',
);

assert.match(
  composeSource,
  /const shouldShowComposerPending = pendingForCurrentSession\s*&& \(pendingSend\?\.stage === "uploading" \|\| pendingSend\?\.stage === "sending"\);/,
  'composer footer status should be limited to upload\/send transport stages',
);

assert.match(
  composeSource,
  /typeof syncComposerPendingTurnFeedback === "function"/,
  'composer flow should sync inline pending-turn feedback in the message stream',
);

assert.match(
  uiSource,
  /function syncComposerPendingTurnFeedback\(/,
  'ui should expose a pending-turn sync helper',
);

assert.match(
  uiSource,
  /msg-user-local-echo/,
  'ui should render a local echo wrapper for just-sent user turns',
);

assert.match(
  uiSource,
  /compose\.inline\.checking/,
  'ui should use dedicated inline i18n keys for message-level checking state',
);

assert.match(
  cssSource,
  /\.msg-user-status\s*\{/,
  'chat message styles should include an inline user-turn status row',
);

assert.match(
  cssSource,
  /\.msg-user-local-echo \.msg-user-bubble\s*\{/,
  'chat message styles should visibly distinguish the local echo bubble',
);

assert.match(
  i18nSource,
  /"compose\.inline\.checking": "Sent, checking what happens next…"/,
  'english i18n should include inline checking copy',
);

assert.match(
  i18nSource,
  /"compose\.inline\.checking": "已发送，正在检查后续处理…"/,
  'chinese i18n should include inline checking copy',
);

console.log('test-chat-pending-turn-feedback: ok');
