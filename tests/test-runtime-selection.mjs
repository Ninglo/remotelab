#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const repoRoot = process.cwd();
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-runtime-selection-'));
process.env.HOME = tempHome;

try {
  const {
    getAutoRuntimeSelection,
    normalizeUiRuntimeSelection,
  } = await import(pathToFileURL(join(repoRoot, 'lib', 'runtime-selection.mjs')).href);
  const {
    resolveExternalRuntimeSelection,
  } = await import(pathToFileURL(join(repoRoot, 'lib', 'external-runtime-selection.mjs')).href);

  const expected = {
    selectedTool: 'codex',
    selectedModel: 'auto',
    selectedEffort: '',
    reasoningKind: 'none',
  };
  assert.deepEqual(getAutoRuntimeSelection(), expected);

  const normalizedLegacy = normalizeUiRuntimeSelection({
    selectedTool: 'codex',
    selectedModel: 'gpt-5.4',
    selectedEffort: 'xhigh',
    reasoningKind: 'enum',
  });
  assert.equal(normalizedLegacy.selectedModel, 'gpt-5.6-sol');
  assert.equal(normalizedLegacy.selectedEffort, 'xhigh');

  assert.equal(
    resolveExternalRuntimeSelection({ uiSelection: getAutoRuntimeSelection() }).model,
    'auto',
    'external connectors should start every new Session from Auto',
  );
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}

console.log('runtime selection tests passed');
