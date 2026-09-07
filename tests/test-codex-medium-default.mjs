#!/usr/bin/env node
// Retain the historical test entry point while testing the replacement default.
import assert from 'assert/strict';
import { readFile } from 'fs/promises';
import vm from 'vm';
import {
  PRODUCT_DEFAULT_CODEX_MODEL,
  PRODUCT_DEFAULT_CODEX_EFFORT,
  normalizeCodexModelId,
} from '../lib/legacy-micro-agent.mjs';

const bootstrap = await readFile(new URL('../static/chat/bootstrap.js', import.meta.url), 'utf8');
assert.equal(PRODUCT_DEFAULT_CODEX_MODEL, 'gpt-6-astra');
assert.equal(PRODUCT_DEFAULT_CODEX_EFFORT, 'low');
assert.match(bootstrap, /const PRODUCT_DEFAULT_CODEX_MODEL = "gpt-6-astra";/);
assert.match(bootstrap, /const PRODUCT_DEFAULT_CODEX_EFFORT = "low";/);
assert.match(bootstrap, /CODEX_EFFORT_DEFAULT_MIGRATION_VERSION = "gpt6-low-v1"/);
assert.equal(normalizeCodexModelId('gpt-5.4'), 'gpt-6-astra', 'major-only GPT-6 IDs must participate in version comparison');
assert.equal(normalizeCodexModelId('gpt-5.6-sol'), 'gpt-5.6-sol', 'one-time migration must not permanently ban explicit older-model choices');

const start = bootstrap.indexOf('function migrateCodexEffortDefaultLocalStorage()');
const end = bootstrap.indexOf('\nmigrateCodexEffortDefaultLocalStorage();', start);
const source = bootstrap.slice(start, end);
const values = new Map([
  ['selectedModel_codex', 'gpt-5.6-sol'],
  ['selectedEffort_codex', 'ultra'],
  ['selectedEffort_codex_gpt-6-astra', 'max'],
  ['selectedModel_pi', 'openai-codex/gpt-5.6-luna'],
  ['selectedModel_pi_openai-codex', 'openai-codex/gpt-5.6-sol'],
  ['selectedEffort_pi_openai-codex/gpt-6-astra', 'max'],
  ['selectedModel_claude', 'opus'],
  ['selectedEffort_claude', 'high'],
  ['selectedModel_pi_moonshotai', 'moonshotai/kimi-k3'],
]);
const context = {
  DEFAULT_TOOL_ID: 'codex',
  PRODUCT_DEFAULT_CODEX_MODEL,
  PRODUCT_DEFAULT_CODEX_EFFORT,
  CODEX_EFFORT_DEFAULT_MIGRATION_VERSION: 'gpt6-low-v1',
  localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
};
vm.runInNewContext(`${source}\nmigrateCodexEffortDefaultLocalStorage();`, context);
assert.equal(values.get('selectedModel_codex'), 'gpt-6-astra');
assert.equal(values.get('selectedEffort_codex'), 'low');
assert.equal(values.get('selectedEffort_codex_gpt-6-astra'), 'low');
assert.equal(values.get('selectedModel_pi'), 'openai-codex/gpt-6-astra');
assert.equal(values.get('selectedModel_pi_openai-codex'), 'openai-codex/gpt-6-astra');
assert.equal(values.get('selectedEffort_pi'), 'low');
assert.equal(values.get('selectedEffort_pi_openai-codex/gpt-6-astra'), 'low');
assert.equal(values.get('selectedModel_claude'), 'opus');
assert.equal(values.get('selectedEffort_claude'), 'high');
assert.equal(values.get('selectedModel_pi_moonshotai'), 'moonshotai/kimi-k3');
values.set('selectedEffort_codex', 'high');
values.set('selectedModel_codex', 'gpt-5.6-terra');
vm.runInNewContext('migrateCodexEffortDefaultLocalStorage();', context);
assert.equal(values.get('selectedEffort_codex'), 'high', 'later explicit preferences must survive reload');
assert.equal(values.get('selectedModel_codex'), 'gpt-5.6-terra');
values.delete('codexEffortDefaultMigration');
values.set('selectedModel_pi', 'moonshotai/kimi-k3');
values.set('selectedEffort_pi', 'max');
vm.runInNewContext('migrateCodexEffortDefaultLocalStorage();', context);
assert.equal(values.get('selectedModel_pi'), 'moonshotai/kimi-k3');
assert.equal(values.get('selectedEffort_pi'), 'max');
console.log('test-gpt6-low-default: ok');
