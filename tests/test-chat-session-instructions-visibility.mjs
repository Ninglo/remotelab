#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createSessionDetail } from '../chat/session-api-shapes.mjs';
import {
  createModelContextSlot,
  describeModelContextSlots,
  renderModelContextSlots,
} from '../chat/model-context-slots.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const template = readFileSync(join(repoRoot, 'templates', 'chat.html'), 'utf8');
const css = readFileSync(join(repoRoot, 'static', 'chat', 'chat-messages.css'), 'utf8');
const uiSource = readFileSync(join(repoRoot, 'static', 'chat', 'ui.js'), 'utf8');
const sessionHttpSource = readFileSync(join(repoRoot, 'static', 'chat', 'session-http.js'), 'utf8');

assert.doesNotMatch(template, /sessionInstructionsPanel/, 'model context should not use a one-off panel above the transcript');
assert.doesNotMatch(css, /session-instructions-panel/, 'the removed one-off panel should not retain special CSS');
assert.match(uiSource, /evt\?\.contextKind === "model" \? t\("activity\.modelContext"\)/,
  'model-owned context should retain a labeled Markdown view inside the Thought activity surface');
assert.match(uiSource, /preserveHiddenBlocks/,
  'model-owned context should preserve hidden-block text in that view');
assert.match(
  sessionHttpSource,
  /systemPrompt: typeof session\.systemPrompt === "string" \? session\.systemPrompt : null/,
  'attached-session refresh should still observe connector instruction changes',
);

const detail = createSessionDetail({
  id: 'session_prompt',
  name: 'Prompt visibility',
  systemPrompt: 'Persist every transcript for the daily review.',
  sourceContext: { secretProjection: 'not returned' },
});
assert.equal(detail.systemPrompt, 'Persist every transcript for the daily review.');
assert.equal(detail.sourceContext, undefined, 'raw per-message source context remains excluded from the Session shape');

const slots = [
  createModelContextSlot('source_runtime', 'Source/runtime instructions', 'Reply through Feishu.'),
  createModelContextSlot('session_instructions', 'Session instructions', detail.systemPrompt),
  createModelContextSlot('turn_context', 'Per-turn context', 'Request ID: req-1'),
].filter(Boolean);
const rendered = renderModelContextSlots(slots);
assert.match(rendered, /^## Source\/runtime instructions/m);
assert.match(rendered, /^## Session instructions/m);
assert.match(rendered, /Persist every transcript for the daily review\./);
assert.match(rendered, /^## Per-turn context/m);
assert.deepEqual(describeModelContextSlots(slots), [
  { id: 'source_runtime', title: 'Source/runtime instructions', delivery: 'turn' },
  { id: 'session_instructions', title: 'Session instructions', delivery: 'turn' },
  { id: 'turn_context', title: 'Per-turn context', delivery: 'turn' },
]);

console.log('test-chat-session-instructions-visibility: ok');
