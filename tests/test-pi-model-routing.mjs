#!/usr/bin/env node
import assert from 'assert/strict';

import { buildPiArgs } from '../chat/adapters/pi.mjs';
import {
  buildPiModelRouteId,
  parsePiModelList,
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
