#!/usr/bin/env node
import assert from 'assert/strict';

import { buildPiArgs } from '../chat/adapters/pi.mjs';
import {
  buildPiModelRouteId,
  parsePiModelList,
  parsePiRpcModels,
  resolvePiModelRoute,
} from '../chat/pi-models.mjs';

const catalog = parsePiModelList(`
provider              model             context  max-out  thinking  images
openai                gpt-5.4           272K     128K     yes       yes
openai-codex          gpt-5.4           272K     128K     yes       yes
deepseek              deepseek-chat     128K     8K       no        no
kimi-for-coding       kimi-k2           128K     32K      yes       no
`);

assert.deepEqual(
  catalog.map((model) => ({ id: model.id, label: model.label })),
  [
    { id: 'openai-codex/gpt-5.4', label: 'gpt-5.4' },
    { id: 'deepseek/deepseek-chat', label: 'deepseek-chat' },
    { id: 'kimi-for-coding/kimi-k2', label: 'kimi-k2' },
  ],
  'Pi should hide provider details in labels, dedupe GPT API routes, and retain non-OpenAI models',
);
assert.equal(buildPiModelRouteId('deepseek', 'deepseek-chat'), 'deepseek/deepseek-chat');
assert.equal(catalog[1].provider, 'deepseek');
assert.equal(catalog[1].providerLabel, 'DeepSeek');

const rpcCatalog = parsePiRpcModels([
  {
    provider: 'openai-codex',
    id: 'gpt-5.6-sol',
    reasoning: true,
    thinkingLevelMap: { minimal: 'low', xhigh: 'xhigh', max: 'max' },
  },
  {
    provider: 'moonshotai',
    id: 'kimi-k3',
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: 'low',
      medium: null,
      high: 'high',
      xhigh: null,
      max: 'max',
    },
    compat: { supportsReasoningEffort: true },
  },
  {
    provider: 'glm-api',
    id: 'glm-5.3-flash',
    reasoning: true,
    compat: { supportsReasoningEffort: false, thinkingFormat: 'zai' },
  },
  {
    provider: 'moonshotai',
    id: 'kimi-k2.7-code',
    reasoning: true,
    thinkingLevelMap: { off: null },
    compat: { supportsReasoningEffort: false },
  },
]);
assert.deepEqual(
  rpcCatalog.map((model) => ({
    id: model.id,
    provider: model.provider,
    levels: model.reasoning.levels || [],
    control: model.reasoning.control || '',
    default: model.reasoning.default || '',
    kind: model.reasoning.kind,
  })),
  [
    {
      id: 'openai-codex/gpt-5.6-sol',
      provider: 'openai-codex',
      levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      control: '',
      default: 'medium',
      kind: 'enum',
    },
    {
      id: 'moonshotai/kimi-k3',
      provider: 'moonshotai',
      levels: ['low', 'high', 'max'],
      control: '',
      default: 'high',
      kind: 'enum',
    },
    {
      id: 'glm-api/glm-5.3-flash',
      provider: 'glm-api',
      levels: ['off', 'medium'],
      control: 'binary',
      default: 'medium',
      kind: 'enum',
    },
    {
      id: 'moonshotai/kimi-k2.7-code',
      provider: 'moonshotai',
      levels: [],
      control: '',
      default: '',
      kind: 'none',
    },
  ],
  'Pi RPC metadata should expose provider grouping and each model’s real thinking control shape',
);
assert.deepEqual(
  resolvePiModelRoute('kimi-for-coding/kimi-k2'),
  { provider: 'kimi-for-coding', model: 'kimi-k2' },
);
assert.deepEqual(
  resolvePiModelRoute('gpt-5.6-sol'),
  { provider: 'openai-codex', model: 'gpt-5.6-sol' },
  'legacy unqualified Pi model selections should stay on the Codex login path',
);
assert.deepEqual(
  buildPiArgs('Ping', {
    provider: 'deepseek',
    model: 'deepseek-chat',
    sessionId: 'session-1',
    thinking: 'high',
  }).slice(0, 11),
  [
    '--mode', 'json',
    '--provider', 'deepseek',
    '--approve',
    '--session-id', 'session-1',
    '--model', 'deepseek-chat',
    '--thinking', 'high',
  ],
  'Pi invocation should receive the internally resolved provider and provider-native model id',
);

console.log('test-pi-model-routing: ok');

