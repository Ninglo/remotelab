#!/usr/bin/env node
import assert from 'assert/strict';
import { execFile } from 'child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

const root = await mkdtemp(join(tmpdir(), 'remotelab-pi-baseline-'));
process.env.HOME = root;
process.env.PI_CODING_AGENT_DIR = join(root, 'runtime');
process.env.REMOTELAB_CONFIG_DIR = join(root, 'config');
delete process.env.REMOTELAB_MACHINE_PI_AGENT_DIR;
delete process.env.REMOTELAB_INSTANCE_ROOT;
const { ensurePiModelBaseline, mergePiBaselineConfig } = await import('../chat/pi-model-baseline.mjs');
const { CODEX_MODEL_CATALOG, getPiBaselineModels } = await import('../lib/codex-model-catalog.mjs');
const { discoverPiModels } = await import('../chat/pi-models.mjs');
const { createToolInvocation } = await import('../chat/process-runner.mjs');
const ids = CODEX_MODEL_CATALOG.map((model) => `openai-codex/${model.id}`);

try {
  const baselineCosts = Object.fromEntries(getPiBaselineModels().map((model) => [model.id, model.cost]));
  assert.deepEqual(
    baselineCosts['gpt-5.6-sol'],
    {
      input: 4,
      output: 20,
      cacheRead: 0.4,
      cacheWrite: 5,
      tiers: [{ inputTokensAbove: 272000, input: 8, output: 30, cacheRead: 0.8, cacheWrite: 10 }],
    },
    'GPT-5.6 Sol should expose current promotional Standard and long-context rates',
  );
  assert.deepEqual(
    [baselineCosts['gpt-5.6-terra'], baselineCosts['gpt-5.6-luna']],
    [
      {
        input: 2,
        output: 12,
        cacheRead: 0.2,
        cacheWrite: 2.5,
        tiers: [{ inputTokensAbove: 272000, input: 4, output: 18, cacheRead: 0.4, cacheWrite: 5 }],
      },
      {
        input: 0.2,
        output: 1.2,
        cacheRead: 0.02,
        cacheWrite: 0.25,
        tiers: [{ inputTokensAbove: 272000, input: 0.4, output: 1.8, cacheRead: 0.04, cacheWrite: 0.5 }],
      },
    ],
    'GPT-5.6 Terra and Luna should expose current Standard and long-context rates',
  );

  const local = {
    providers: {
      'openai-codex': {
        baseUrl: 'https://proxy.example.test',
        headers: { 'x-test': '$PROXY_HEADER' },
        models: [{ id: 'gpt-6-astra', contextWindow: 123456 }, { id: 'private-model' }],
        modelOverrides: { 'gpt-5.6-sol': { contextWindow: 65536 } },
      },
      other: { apiKey: '$OTHER_API_KEY', models: [{ id: 'another-model' }] },
    },
  };
  const before = structuredClone(local);
  const merged = mergePiBaselineConfig(local);
  assert.deepEqual(local, before, 'merging must not mutate input');
  assert.deepEqual(merged.providers.other, before.providers.other);
  assert.deepEqual(merged.providers['openai-codex'].models.slice(0, 2), before.providers['openai-codex'].models);
  assert.deepEqual(merged.providers['openai-codex'].modelOverrides, before.providers['openai-codex'].modelOverrides);
  assert.equal(merged.providers['openai-codex'].baseUrl, before.providers['openai-codex'].baseUrl);
  assert.equal(mergePiBaselineConfig(merged), merged, 'already-projected configs are no-ops');
  for (const malformed of [null, [], { providers: [] }, { providers: { 'openai-codex': { models: {} } } }]) {
    assert.throws(() => mergePiBaselineConfig(malformed), /Invalid Pi models.json/);
  }

  const dir = join(root, 'parallel');
  await mkdir(dir);
  await writeFile(join(dir, 'models.json'), JSON.stringify(local));
  await writeFile(join(dir, 'auth.json'), 'do not touch credentials');
  const moduleUrl = new URL('../chat/pi-model-baseline.mjs', import.meta.url).href;
  await Promise.all(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath, [
    '--input-type=module', '-e',
    `const {ensurePiModelBaseline} = await import(${JSON.stringify(moduleUrl)}); await ensurePiModelBaseline(${JSON.stringify(dir)});`,
  ])));
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'models.json'), 'utf8')), merged);
  assert.equal(await readFile(join(dir, 'auth.json'), 'utf8'), 'do not touch credentials');
  assert.equal((await stat(join(dir, 'models.json'))).mode & 0o777, 0o600);
  const previousMtime = (await stat(join(dir, 'models.json'))).mtimeMs;
  await ensurePiModelBaseline(dir);
  assert.equal((await stat(join(dir, 'models.json'))).mtimeMs, previousMtime);

  const brokenDir = join(root, 'broken');
  await mkdir(brokenDir);
  await writeFile(join(brokenDir, 'models.json'), '{broken');
  await assert.rejects(ensurePiModelBaseline(brokenDir), SyntaxError);
  assert.equal(await readFile(join(brokenDir, 'models.json'), 'utf8'), '{broken');

  // A fake Pi verifies registration happens before either discovery command.
  const command = join(root, 'pi');
  await writeFile(command, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const config = JSON.parse(fs.readFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'models.json')));
if (!config.providers['openai-codex'].models.some(m => m.id === 'gpt-6-astra')) process.exit(99);
const scenario = process.env.TEST_PI_SCENARIO;
if (scenario === 'failed' || (scenario === 'text' && process.argv.includes('rpc'))) process.exit(1);
if (process.argv.includes('--list-models')) {
  console.log('provider  model  context  max-out  thinking  images\\nopenai-codex  gpt-5.6-sol  272K  128K  yes  yes');
} else {
  const models = scenario === 'empty' ? [] : [
    {provider: 'openai-codex', id: 'gpt-5.6-sol', reasoning: true, thinkingLevelMap: {off:null, minimal:null, xhigh:'xhigh', max:'max'}},
    {provider: 'openai-codex', id: 'gpt-future', reasoning: true},
    {provider: 'deepseek', id: 'deepseek-chat', reasoning: false},
    {provider: 'openai', id: 'gpt-6-astra', reasoning: true},
  ];
  require('readline').createInterface({input: process.stdin}).on('line', line => {
    const request = JSON.parse(line);
    console.log(JSON.stringify({id: request.id, success: true, data: request.type === 'get_state' ? {model: models[0]} : {models}}));
  });
}
`, { mode: 0o755 });

  const env = { ...process.env, PI_CODING_AGENT_DIR: join(root, 'discovery') };
  const found = await discoverPiModels({ command, env, refresh: true });
  assert.deepEqual(found.models.slice(0, ids.length).map((model) => model.id), ids);
  assert.equal(found.models.filter((model) => model.id === ids[1]).length, 1);
  assert(found.models.some((model) => model.id === 'openai-codex/gpt-future'));
  assert(found.models.some((model) => model.id === 'deepseek/deepseek-chat'));
  assert(!found.models.some((model) => model.provider === 'openai'));
  assert.equal(found.defaultModel, 'openai-codex/gpt-5.6-sol');
  assert.equal(found.models[0].id, 'openai-codex/gpt-6-astra');
  assert.equal(found.models[0].providerDefault, true);
  assert.equal(found.models[0].reasoning.default, 'low');
  assert.equal(found.models[1].providerDefault, undefined);
  assert.equal(found.models[1].reasoning.default, 'medium');
  assert(!found.models.some((model) => model.effortLevels?.includes('ultra')));

  for (const scenario of ['empty', 'text', 'failed']) {
    const result = await discoverPiModels({ command, env: { ...env, TEST_PI_SCENARIO: scenario }, refresh: true });
    assert.deepEqual(result.models.map((model) => model.id), ids, scenario);
    assert.deepEqual(result.models[0].effortLevels, ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.equal(result.models[0].reasoning.default, 'low');
    assert.equal(result.models[0].providerDefault, true);
    assert(!result.models.some((model) => model.effortLevels?.includes('ultra')));
    assert.equal(Boolean(result.discoveryError), scenario === 'failed');
  }
  await assert.rejects(discoverPiModels({ command, env: { ...env, PI_CODING_AGENT_DIR: brokenDir }, refresh: true }), SyntaxError);
  const freshDir = join(root, 'fresh-context');
  await discoverPiModels({ command, env: { ...env, PI_CODING_AGENT_DIR: freshDir } });
  assert(JSON.parse(await readFile(join(freshDir, 'models.json'), 'utf8')).providers['openai-codex']);

  // Execution must register the same list without a prior discovery call.
  await createToolInvocation('pi', 'Ping', { model: ids[0], effort: 'max' });
  const runtime = JSON.parse(await readFile(join(process.env.PI_CODING_AGENT_DIR, 'models.json'), 'utf8'));
  assert.deepEqual(runtime.providers['openai-codex'].models, getPiBaselineModels());
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log('test-pi-model-baseline: ok');
