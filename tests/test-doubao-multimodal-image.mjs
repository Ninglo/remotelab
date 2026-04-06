/**
 * Integration test: Doubao multimodal image understanding via micro-agent pipeline.
 *
 * Spawns micro-agent-router.mjs with a Doubao model, a real image attachment,
 * and a prompt asking to describe the image. Verifies the response contains
 * meaningful visual description (not just a text-path echo).
 *
 * Requires: live Doubao API key in ~/.config/remotelab/doubao-fast-agent.json
 * Image:    uses a local test image (autumn road photograph)
 */

import assert from 'assert/strict';
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { join, resolve } from 'path';

const repoRoot = process.cwd();
const routerScript = resolve(repoRoot, 'scripts/micro-agent-router.mjs');
const testImagePath = join(process.env.HOME, 'tmp_photo_edit/road_autumn_road_darker_preview.jpg');

if (!existsSync(testImagePath)) {
  console.log('test-doubao-multimodal-image: SKIP (test image not found)');
  process.exit(0);
}

const TIMEOUT_MS = 90_000;

function runMicroAgentRouter({ prompt, model, attachmentPaths }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const args = [routerScript, '-p', prompt, '--model', model, '--output-format', 'stream-json'];
    const env = { ...process.env };
    if (attachmentPaths) {
      env.REMOTELAB_ATTACHMENT_PATHS = JSON.stringify(attachmentPaths);
    }

    const child = execFile('node', args, {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error && error.killed) {
        rejectPromise(new Error(`Process timed out after ${TIMEOUT_MS}ms.\nstderr: ${stderr}`));
        return;
      }

      const lines = stdout.trim().split('\n').filter(Boolean);
      const events = [];
      for (const line of lines) {
        try {
          events.push(JSON.parse(line));
        } catch {
          // skip non-JSON lines
        }
      }
      resolvePromise({ exitCode: error ? error.code ?? 1 : 0, events, stderr });
    });
  });
}

function extractAssistantText(events) {
  for (const event of events) {
    if (event.type === 'assistant' && event.message?.content) {
      const content = event.message.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content
          .filter((part) => part.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text)
          .join('\n');
      }
    }
  }
  return '';
}

// --- Test 1: Text-only (baseline, no image) ---
console.log('  [1/2] Testing text-only Doubao response...');
const textResult = await runMicroAgentRouter({
  prompt: '用一句话回答：1+1等于几？',
  model: 'doubao-seed-2-0-pro-260215',
});

assert.equal(textResult.exitCode, 0, `Text-only run failed (exit ${textResult.exitCode}):\n${textResult.stderr}`);
const textResponse = extractAssistantText(textResult.events);
assert(textResponse.length > 0, 'Text-only response should not be empty');
assert(textResponse.includes('2'), `Expected "2" in response, got: ${textResponse}`);
console.log(`    ✓ Text response: "${textResponse.slice(0, 80)}"`);

// --- Test 2: Multimodal image understanding ---
console.log('  [2/2] Testing multimodal image understanding...');
const imageResult = await runMicroAgentRouter({
  prompt: '这张图片拍的是什么场景？用一两句话简要描述，不要调用任何工具。',
  model: 'doubao-seed-2-0-pro-260215',
  attachmentPaths: [
    { path: testImagePath, mimeType: 'image/jpeg', originalName: 'autumn_road.jpg' },
  ],
});

assert.equal(imageResult.exitCode, 0, `Image run failed (exit ${imageResult.exitCode}):\n${imageResult.stderr}`);
const imageResponse = extractAssistantText(imageResult.events);
assert(imageResponse.length > 0, 'Image response should not be empty');

// The image is an autumn mountain road — the model should mention road/path/highway or
// autumn/fall/trees/mountain/foliage or colors like orange/yellow/red/golden.
const visualKeywords = ['路', '公路', '道路', '盘山', '秋', '树', '山', '林', '落叶', '金', '黄', '红', '橙', 'road', 'autumn', 'tree', 'mountain', 'fall'];
const hasVisualContent = visualKeywords.some((keyword) => imageResponse.includes(keyword));
assert(hasVisualContent, `Response should describe the autumn road image, but got: "${imageResponse}"`);
console.log(`    ✓ Image response: "${imageResponse.slice(0, 120)}"`);

// --- Verify result event exists ---
const resultEvent = imageResult.events.find((e) => e.type === 'result');
assert(resultEvent, 'Should have a result event');
assert.equal(resultEvent.is_error, false, 'Result should not be an error');

console.log('test-doubao-multimodal-image: ok');
