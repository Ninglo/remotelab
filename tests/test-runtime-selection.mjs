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
    loadUiRuntimeSelection,
    saveUiRuntimeSelection,
  } = await import(pathToFileURL(join(repoRoot, 'lib', 'runtime-selection.mjs')).href);
  const {
    resolveExternalRuntimeSelection,
  } = await import(pathToFileURL(join(repoRoot, 'lib', 'external-runtime-selection.mjs')).href);

  assert.equal(await loadUiRuntimeSelection(), null);

  const first = await saveUiRuntimeSelection({
    selectedTool: 'claude',
    selectedModel: 'claude-sonnet-4-5',
    selectedEffort: 'high',
    reasoningKind: 'enum',
  });
  assert.equal(first.selectedTool, 'claude');
  assert.equal(first.selectedModel, 'claude-sonnet-4-5');
  assert.equal(first.selectedEffort, 'high');
  assert.equal(first.reasoningKind, 'enum');
  assert.equal(Object.hasOwn(first, 'thinkingEnabled'), false);

  const loadedFirst = await loadUiRuntimeSelection();
  assert.equal(loadedFirst?.selectedTool, 'claude');
  assert.equal(loadedFirst?.selectedModel, 'claude-sonnet-4-5');
  assert.equal(loadedFirst?.selectedEffort, 'high');
  assert.equal(loadedFirst?.reasoningKind, 'enum');
  assert.equal(Object.hasOwn(loadedFirst, 'thinkingEnabled'), false);

  const second = await saveUiRuntimeSelection({
    selectedTool: 'codex',
    selectedModel: 'gpt-5-codex',
    selectedEffort: 'high',
    reasoningKind: 'enum',
  });
  assert.equal(second.selectedTool, 'codex');
  assert.equal(second.selectedModel, 'gpt-5-codex');
  assert.equal(second.selectedEffort, 'high');
  assert.equal(second.reasoningKind, 'enum');

  const loadedSecond = await loadUiRuntimeSelection();
  assert.equal(loadedSecond?.selectedTool, 'codex');
  assert.equal(loadedSecond?.selectedModel, 'gpt-5-codex');
  assert.equal(loadedSecond?.selectedEffort, 'high');
  assert.equal(loadedSecond?.reasoningKind, 'enum');

  const staleCodex = await saveUiRuntimeSelection({
    selectedTool: 'codex',
    selectedModel: 'gpt-5.4',
    selectedEffort: 'xhigh',
    reasoningKind: 'enum',
  });
  assert.equal(
    staleCodex.selectedModel,
    'gpt-5.6-sol',
    'stale Codex UI runtime selections should upgrade to the product default model',
  );
  assert.equal(staleCodex.selectedEffort, 'xhigh');

  const currentOlderCodex = await saveUiRuntimeSelection({
    selectedTool: 'codex',
    selectedModel: 'gpt-5.2',
    selectedEffort: 'medium',
    reasoningKind: 'enum',
  });
  assert.equal(
    currentOlderCodex.selectedModel,
    'gpt-5.2',
    'all models in the current Codex picker should remain selectable',
  );

  assert.equal(
    resolveExternalRuntimeSelection({
      uiSelection: {
        selectedTool: 'codex',
        selectedModel: 'gpt-5.4',
        selectedEffort: 'high',
        reasoningKind: 'enum',
      },
    }).model,
    'gpt-5.6-sol',
    'external connectors should not inherit stale Codex UI models',
  );

  const removedToggle = await saveUiRuntimeSelection({
    selectedTool: 'claude',
    selectedModel: 'claude-sonnet-4-5',
    thinkingEnabled: true,
    reasoningKind: 'toggle',
  });
  assert.equal(removedToggle.reasoningKind, 'none', 'removed toggle selections should not survive normalization');
  assert.equal(Object.hasOwn(removedToggle, 'thinkingEnabled'), false);

  await assert.rejects(() => saveUiRuntimeSelection({ reasoningKind: 'enum' }), /selectedTool is required/);
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}

console.log('runtime selection tests passed');
