#!/usr/bin/env node
import assert from 'assert/strict';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const bootstrapSource = readFileSync(join(repoRoot, 'static', 'chat', 'bootstrap.js'), 'utf8');
const layoutToolingSource = readFileSync(join(repoRoot, 'static', 'chat', 'layout-tooling.js'), 'utf8');

assert.match(
  bootstrapSource,
  /const PRODUCT_DEFAULT_CODEX_MODEL = "gpt-5\.6-sol";/,
  'the browser default should stay aligned with the GPT-5.6-Sol product default',
);

function extractFunctionSource(source, functionName) {
  const marker = `function ${functionName}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${functionName} should exist`);
  const paramsStart = source.indexOf('(', start);
  let paramsDepth = 0;
  let braceStart = -1;
  for (let index = paramsStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') paramsDepth += 1;
    if (char === ')') {
      paramsDepth -= 1;
      if (paramsDepth === 0) {
        braceStart = source.indexOf('{', index);
        break;
      }
    }
  }
  assert.notEqual(braceStart, -1, `${functionName} should have a body`);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  throw new Error(`Unable to extract ${functionName}`);
}

const normalizeToolIdSource = extractFunctionSource(layoutToolingSource, 'normalizeToolId');
const filterPrimaryToolOptionsSource = extractFunctionSource(layoutToolingSource, 'filterPrimaryToolOptions');
const prioritizeToolOptionsSource = extractFunctionSource(layoutToolingSource, 'prioritizeToolOptions');
const resolvePreferredToolIdSource = extractFunctionSource(layoutToolingSource, 'resolvePreferredToolId');
const normalizeStoredToolIdSource = extractFunctionSource(bootstrapSource, 'normalizeStoredToolId');
const derivePreferredToolIdSource = extractFunctionSource(bootstrapSource, 'derivePreferredToolId');
const parseVersionedGptModelIdSource = extractFunctionSource(bootstrapSource, 'parseVersionedGptModelId');
const isStaleCodexModelIdSource = extractFunctionSource(bootstrapSource, 'isStaleCodexModelId');
const normalizeStoredCodexModelIdSource = extractFunctionSource(bootstrapSource, 'normalizeStoredCodexModelId');
const migrateRetiredCodexModelLocalStorageSource = extractFunctionSource(
  bootstrapSource,
  'migrateRetiredCodexModelLocalStorage',
);

const localStorageValues = new Map([
  ['selectedModel_codex', 'gpt-5.4'],
  ['selectedEffort_codex', 'xhigh'],
]);

const context = {
  console,
  DEFAULT_TOOL_ID: 'codex',
  PRODUCT_DEFAULT_CODEX_MODEL: 'gpt-5.6-sol',
  CURRENT_CODEX_MODEL_IDS: new Set([
    'gpt-6-astra',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.5',
    'gpt-5.2',
  ]),
  RETIRED_CODEX_MODEL_IDS: new Set([]),
  LEGACY_AUTO_PREFERRED_TOOL_IDS: new Set(['codex', 'micro-agent']),
  LEGACY_REMOVED_TOOL_IDS: new Set(['micro-agent']),
  localStorage: {
    getItem(key) {
      return localStorageValues.has(key) ? localStorageValues.get(key) : null;
    },
    setItem(key, value) {
      localStorageValues.set(key, String(value));
    },
  },
};
context.globalThis = context;

vm.runInNewContext(
  [
    normalizeToolIdSource,
    filterPrimaryToolOptionsSource,
    prioritizeToolOptionsSource,
    resolvePreferredToolIdSource,
    normalizeStoredToolIdSource,
    derivePreferredToolIdSource,
    parseVersionedGptModelIdSource,
    isStaleCodexModelIdSource,
    normalizeStoredCodexModelIdSource,
    migrateRetiredCodexModelLocalStorageSource,
    'globalThis.filterPrimaryToolOptions = filterPrimaryToolOptions;',
    'globalThis.prioritizeToolOptions = prioritizeToolOptions;',
    'globalThis.resolvePreferredToolId = resolvePreferredToolId;',
    'globalThis.derivePreferredToolId = derivePreferredToolId;',
    'globalThis.migrateRetiredCodexModelLocalStorage = migrateRetiredCodexModelLocalStorage;',
  ].join('\n\n'),
  context,
  { filename: 'static/chat/layout-tooling.js' },
);

const ordered = context.prioritizeToolOptions(context.filterPrimaryToolOptions([
  { id: 'claude', name: 'Claude Code' },
  { id: 'micro-agent', name: 'Micro Agent' },
  { id: 'codex', name: 'CodeX' },
]));
assert.deepEqual(
  Array.from(ordered, (tool) => tool.id),
  ['codex', 'claude'],
  'legacy Micro Agent should be removed from the primary picker',
);

assert.equal(
  context.resolvePreferredToolId(ordered, []),
  'codex',
  'new picker defaults should fall back to CodeX when no explicit choice exists',
);

assert.equal(
  context.resolvePreferredToolId(ordered, ['codex']),
  'codex',
  'explicit selections should still win over the product default',
);

assert.equal(
  context.derivePreferredToolId('codex', ''),
  null,
  'auto-saved codex default should yield to the current product default',
);

assert.equal(
  context.derivePreferredToolId('codex', 'codex'),
  'codex',
  'explicit codex selections should still be preserved',
);

assert.equal(
  context.derivePreferredToolId('micro-agent', ''),
  null,
  'legacy auto-saved micro-agent default should no longer pin new sessions',
);

assert.equal(
  context.derivePreferredToolId('micro-agent', 'micro-agent'),
  'codex',
  'legacy explicit micro-agent selections should be migrated to CodeX',
);

assert.equal(
  context.derivePreferredToolId('claude', ''),
  'claude',
  'Claude should remain a valid explicit preferred tool once it is visible again',
);

assert.equal(
  context.derivePreferredToolId('', 'claude'),
  'claude',
  'legacy Claude selections should still hydrate once Claude is visible again',
);

context.migrateRetiredCodexModelLocalStorage();
assert.equal(
  localStorageValues.get('selectedModel_codex'),
  'gpt-5.6-sol',
  'stale GPT-5.4 browser preferences should migrate to GPT-5.6-Sol',
);
assert.equal(
  localStorageValues.get('selectedEffort_codex'),
  'xhigh',
  'model migration should preserve an existing compatible effort preference',
);

localStorageValues.set('selectedModel_codex', 'gpt-5.2');
context.migrateRetiredCodexModelLocalStorage();
assert.equal(
  localStorageValues.get('selectedModel_codex'),
  'gpt-5.2',
  'current Codex catalog models should remain selectable even when their version is below the product default',
);

const allVisible = context.filterPrimaryToolOptions([
  { id: 'codex', name: 'CodeX' },
  { id: 'micro-agent', name: 'Micro Agent', visibility: 'private' },
  { id: 'claude', name: 'Claude Code' },
]);
assert.deepEqual(
  Array.from(allVisible, (tool) => tool.id),
  ['codex', 'claude'],
  'legacy Micro Agent should be hidden from primary tool options',
);

const keptPrivate = context.filterPrimaryToolOptions([
  { id: 'codex', name: 'CodeX' },
  { id: 'micro-agent', name: 'Micro Agent', visibility: 'private' },
], { keepIds: ['micro-agent'] });
assert.deepEqual(
  Array.from(keptPrivate, (tool) => tool.id),
  ['codex'],
  'legacy Micro Agent should stay hidden even when stale state references it',
);

const keptHiddenClaude = context.filterPrimaryToolOptions([
  { id: 'codex', name: 'CodeX' },
  { id: 'claude', name: 'Claude Code' },
], { keepIds: ['claude'] });
assert.deepEqual(
  Array.from(keptHiddenClaude, (tool) => tool.id),
  ['codex', 'claude'],
  'Claude should remain visible for existing sessions as a normal public tool',
);

console.log('test-chat-tool-default-preference: ok');
