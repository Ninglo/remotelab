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

const piInvocation = buildRuntimeInvocation('pi-json', 'Ping', {
  piSessionId: 'remote-session-1',
  model: 'fake-model',
  effort: 'high',
}, 'pi');
assert.equal(piInvocation.isPiFamily, true);
assert.equal(piInvocation.isCodexFamily, false);
assert.equal(piInvocation.runtimeFamily, 'pi-json');
assert.deepEqual(piInvocation.args.slice(0, 5), ['--mode', 'json', '--provider', 'openai-codex', '--approve']);
assert.ok(piInvocation.args.includes('remote-session-1'));

const manifestFallbackInvocation = await createToolInvocation('missing-runtime', 'Ping', {
  runtimeFamily: 'codex-json',
  model: 'fake-model',
  effort: 'low',
});
assert.equal(manifestFallbackInvocation.runtimeFamily, 'codex-json');
assert.equal(manifestFallbackInvocation.isCodexFamily, true);

console.log('test-process-runner-runtime-family: ok');
