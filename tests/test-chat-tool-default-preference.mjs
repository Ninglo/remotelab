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
const normalizeToolVisibilitySource = extractFunctionSource(layoutToolingSource, 'normalizeToolVisibility');
const filterPrimaryToolOptionsSource = extractFunctionSource(layoutToolingSource, 'filterPrimaryToolOptions');
const prioritizeToolOptionsSource = extractFunctionSource(layoutToolingSource, 'prioritizeToolOptions');
const resolvePreferredToolIdSource = extractFunctionSource(layoutToolingSource, 'resolvePreferredToolId');
const normalizeStoredToolIdSource = extractFunctionSource(bootstrapSource, 'normalizeStoredToolId');
const derivePreferredToolIdSource = extractFunctionSource(bootstrapSource, 'derivePreferredToolId');

const context = {
  console,
  DEFAULT_TOOL_ID: 'micro-agent',
  LEGACY_AUTO_PREFERRED_TOOL_IDS: new Set(['codex', 'micro-agent']),
};
context.globalThis = context;

vm.runInNewContext(
  [
    normalizeToolIdSource,
    normalizeToolVisibilitySource,
    filterPrimaryToolOptionsSource,
    prioritizeToolOptionsSource,
    resolvePreferredToolIdSource,
    normalizeStoredToolIdSource,
    derivePreferredToolIdSource,
    'globalThis.filterPrimaryToolOptions = filterPrimaryToolOptions;',
    'globalThis.prioritizeToolOptions = prioritizeToolOptions;',
    'globalThis.resolvePreferredToolId = resolvePreferredToolId;',
    'globalThis.derivePreferredToolId = derivePreferredToolId;',
  ].join('\n\n'),
  context,
  { filename: 'static/chat/layout-tooling.js' },
);

const ordered = context.prioritizeToolOptions([
  { id: 'claude', name: 'Claude Code' },
  { id: 'micro-agent', name: 'Micro Agent' },
  { id: 'codex', name: 'CodeX' },
]);
assert.deepEqual(
  Array.from(ordered, (tool) => tool.id),
  ['micro-agent', 'claude', 'codex'],
  'Micro Agent should be promoted to the front of the picker when available',
);

assert.equal(
  context.resolvePreferredToolId(ordered, []),
  'micro-agent',
  'new picker defaults should fall back to Micro Agent when no explicit choice exists',
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
  'micro-agent',
  'explicit micro-agent selections should still be preserved',
);

assert.equal(
  context.derivePreferredToolId('', 'claude'),
  'claude',
  'legacy non-default selections should still survive the migration',
);

const publicOnly = context.filterPrimaryToolOptions([
  { id: 'codex', name: 'CodeX' },
  { id: 'micro-agent', name: 'Micro Agent', visibility: 'private' },
  { id: 'doubao-fast', name: 'Doubao Fast Agent', visibility: 'private' },
  { id: 'claude', name: 'Claude Code' },
]);
assert.deepEqual(
  Array.from(publicOnly, (tool) => tool.id),
  ['codex', 'micro-agent', 'claude'],
  'the product-default private agent should stay visible while other private agents stay hidden',
);

const keptPrivate = context.filterPrimaryToolOptions([
  { id: 'codex', name: 'CodeX' },
  { id: 'micro-agent', name: 'Micro Agent', visibility: 'private' },
], { keepIds: ['micro-agent'] });
assert.deepEqual(
  Array.from(keptPrivate, (tool) => tool.id),
  ['codex', 'micro-agent'],
  'the current private tool should remain visible when an existing session already uses it',
);

console.log('test-chat-tool-default-preference: ok');
