#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const uiSource = readFileSync(join(repoRoot, 'static', 'chat', 'ui.js'), 'utf8');
const realtimeSource = readFileSync(join(repoRoot, 'static', 'chat', 'realtime.js'), 'utf8');
const realtimeRenderSource = readFileSync(join(repoRoot, 'static', 'chat', 'realtime-render.js'), 'utf8');

for (const snippet of [
  'Load message…',
  'Load command…',
  'Load result…',
  'Load thinking…',
  'Loading hidden steps…',
  'Failed to load hidden steps.',
]) {
  assert.equal(
    uiSource.includes(snippet),
    false,
    `transcript rendering should not reintroduce placeholder copy: ${snippet}`,
  );
}

assert.equal(
  `${realtimeSource}\n${realtimeRenderSource}`.includes('node.dataset.bodyPending = "loading";'),
  false,
  'lazy transcript hydration should not introduce a separate loading state anymore',
);

console.log('test-chat-transcript-placeholder-free: ok');
