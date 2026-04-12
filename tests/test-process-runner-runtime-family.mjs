#!/usr/bin/env node
import assert from 'assert/strict';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const {
  buildRuntimeInvocation,
  createToolInvocation,
} = await import(pathToFileURL(join(repoRoot, 'chat', 'process-runner.mjs')).href);

assert.throws(
  () => buildRuntimeInvocation('', 'Ping', {}, 'missing-runtime'),
  /missing runtimeFamily/,
);

assert.throws(
  () => buildRuntimeInvocation('custom-json', 'Ping', {}, 'broken-runtime'),
  /unsupported runtimeFamily "custom-json"/,
);

const codexInvocation = buildRuntimeInvocation('codex-json', 'Ping', { model: 'fake-model', effort: 'low' }, 'fake-codex');
assert.equal(codexInvocation.isCodexFamily, true);
assert.equal(codexInvocation.isClaudeFamily, false);
assert.equal(codexInvocation.runtimeFamily, 'codex-json');
assert.ok(Array.isArray(codexInvocation.args) && codexInvocation.args.length > 0);

const manifestFallbackInvocation = await createToolInvocation('missing-runtime', 'Ping', {
  runtimeFamily: 'codex-json',
  model: 'fake-model',
  effort: 'low',
});
assert.equal(manifestFallbackInvocation.runtimeFamily, 'codex-json');
assert.equal(manifestFallbackInvocation.isCodexFamily, true);

console.log('test-process-runner-runtime-family: ok');
