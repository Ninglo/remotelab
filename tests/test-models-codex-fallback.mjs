#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-models-codex-'));
const codexDir = join(tempHome, '.codex');
const sessionsDir = join(codexDir, 'sessions', '2026', '04', '20');

mkdirSync(sessionsDir, { recursive: true });

writeFileSync(
  join(codexDir, 'config.toml'),
  'model = "gpt-5.3-codex"\n',
  'utf8',
);

writeFileSync(join(codexDir, 'models_cache.json'), JSON.stringify({ models: [{
  slug: 'gpt-6-astra',
  visibility: 'list',
  default_reasoning_level: 'medium',
  supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(effort => ({ effort })),
}] }));

const olderSessionPath = join(sessionsDir, 'older.jsonl');
writeFileSync(
  olderSessionPath,
  `${JSON.stringify({
    type: 'turn_context',
    payload: { model: 'gpt-5.2-codex' },
  })}\n`,
  'utf8',
);

const newerSessionPath = join(sessionsDir, 'newer.jsonl');
writeFileSync(
  newerSessionPath,
  `${JSON.stringify({
    type: 'turn_context',
    payload: { model: 'gpt-5.4' },
  })}\n`,
  'utf8',
);

utimesSync(olderSessionPath, new Date('2026-04-20T10:00:00Z'), new Date('2026-04-20T10:00:00Z'));
utimesSync(newerSessionPath, new Date('2026-04-20T11:00:00Z'), new Date('2026-04-20T11:00:00Z'));

process.env.HOME = tempHome;
process.env.REMOTELAB_CONFIG_DIR = join(tempHome, '.config', 'remotelab');
delete process.env.REMOTELAB_INSTANCE_ROOT;
process.env.REMOTELAB_MACHINE_CODEX_HOME = codexDir;

try {
  const { getModelsForTool } = await import(pathToFileURL(join(repoRoot, 'chat', 'models.mjs')).href);
  const result = await getModelsForTool('codex');
  const hardcodedModelIds = [
    'gpt-6-astra',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.5',
    'gpt-5.2',
  ];

  assert.equal(
    result.defaultModel,
    'gpt-6-astra',
    'stale configured/recent Codex models should not override the product default',
  );
  assert.deepEqual(
    result.models.slice(0, 4).map((model) => model.id),
    ['gpt-6-astra', 'gpt-5.3-codex', 'gpt-5.4', 'gpt-5.2-codex'],
    'Codex should put the product default first while retaining configured + recent session models',
  );
  assert.deepEqual(
    hardcodedModelIds.every((modelId) => result.models.some((model) => model.id === modelId)),
    true,
    'Codex should always expose the hardcoded baseline model catalog',
  );
  assert.equal(result.models.find(model => model.id === 'gpt-6-astra').defaultEffort, 'low',
    'provider cache defaults must not restore medium when switching to the product-default model');
  assert.deepEqual(result.effortLevels, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.deepEqual(result.reasoning, {
    kind: 'enum',
    label: 'Thinking',
    levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    default: 'low',
  });
} finally {
  delete process.env.REMOTELAB_MACHINE_CODEX_HOME;
  rmSync(tempHome, { recursive: true, force: true });
}

console.log('test-models-codex-fallback: ok');
