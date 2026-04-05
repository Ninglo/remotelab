#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-models-micro-agent-'));
const fakeBin = join(tempHome, '.local', 'bin');
const configDir = join(tempHome, '.config', 'remotelab');

mkdirSync(fakeBin, { recursive: true });
mkdirSync(configDir, { recursive: true });

writeFileSync(join(fakeBin, 'micro-agent-router'), '#!/bin/sh\nexit 0\n', 'utf8');
chmodSync(join(fakeBin, 'micro-agent-router'), 0o755);

writeFileSync(
  join(configDir, 'tools.json'),
  `${JSON.stringify([
    {
      id: 'micro-agent',
      name: 'Micro Agent',
      toolProfile: 'micro-agent',
      command: 'micro-agent-router',
      runtimeFamily: 'claude-stream-json',
      promptMode: 'bare-user',
      flattenPrompt: true,
      models: [
        {
          id: 'gpt-5.4',
          label: 'gpt-5.4',
          reasoningKind: 'enum',
          supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh'],
          defaultReasoning: 'medium',
        },
        {
          id: 'sonnet',
          label: 'Claude Sonnet',
          reasoningKind: 'enum',
          supportedReasoningLevels: ['low', 'medium', 'high'],
          defaultReasoning: 'medium',
        },
        {
          id: 'no-thinking-model',
          label: 'No Thinking Model',
          reasoningKind: 'none',
        },
      ],
      reasoning: { kind: 'none', label: 'Thinking' },
    },
  ], null, 2)}\n`,
  'utf8',
);

process.env.HOME = tempHome;
process.env.PATH = `${fakeBin}:${process.env.PATH || ''}`;

const { getModelsForTool } = await import(pathToFileURL(join(repoRoot, 'chat', 'models.mjs')).href);

try {
  const result = await getModelsForTool('micro-agent');
  assert.equal(result.defaultModel, 'gpt-5.4');
  assert.deepEqual(result.reasoning, {
    kind: 'enum',
    label: 'Thinking',
    levels: ['low', 'medium', 'high', 'xhigh'],
    default: 'medium',
  });
  assert.deepEqual(result.models, [
    {
      id: 'gpt-5.4',
      label: 'gpt-5.4',
      reasoning: {
        kind: 'enum',
        label: 'Thinking',
        levels: ['low', 'medium', 'high', 'xhigh'],
        default: 'medium',
      },
      defaultEffort: 'medium',
      effortLevels: ['low', 'medium', 'high', 'xhigh'],
    },
    {
      id: 'sonnet',
      label: 'Claude Sonnet',
      reasoning: {
        kind: 'enum',
        label: 'Thinking',
        levels: ['low', 'medium', 'high'],
        default: 'medium',
      },
      defaultEffort: 'medium',
      effortLevels: ['low', 'medium', 'high'],
    },
    {
      id: 'no-thinking-model',
      label: 'No Thinking Model',
      reasoning: {
        kind: 'none',
        label: 'Thinking',
      },
    },
  ]);
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}

console.log('test-models-micro-agent-per-model-reasoning: ok');
