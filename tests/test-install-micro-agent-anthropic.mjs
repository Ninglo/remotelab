import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

const repoRoot = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), 'install-micro-agent-anthropic-'));
const homeDir = join(tempRoot, 'home');

mkdirSync(homeDir, { recursive: true });

const result = spawnSync('node', ['scripts/install-micro-agent.mjs', '--provider', 'anthropic', '--api-key', 'test-anthropic-key'], {
  cwd: repoRoot,
  env: {
    ...process.env,
    HOME: homeDir,
  },
  encoding: 'utf8',
});

assert.equal(result.status, 0, result.stderr || result.stdout);

const toolsPath = join(homeDir, '.config', 'remotelab', 'tools.json');
const tools = JSON.parse(readFileSync(toolsPath, 'utf8'));
const record = tools.find((tool) => tool.id === 'micro-agent');

assert(record, 'installed Anthropic micro-agent tool should exist');
assert.equal(record.name, 'Micro Agent');
assert.equal(record.toolProfile, 'micro-agent');
assert.equal(record.visibility, 'private');
assert.match(record.command, /scripts\/anthropic-fast-agent\.mjs$/);
assert.equal(record.runtimeFamily, 'claude-stream-json');
assert.equal(record.promptMode, 'bare-user');
assert.equal(record.flattenPrompt, true);
assert.deepEqual(record.models, [
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
]);
assert.deepEqual(record.reasoning, {
  kind: 'none',
  label: 'Thinking',
});

const configPath = join(homeDir, '.config', 'remotelab', 'anthropic-fast-agent.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
assert.equal(config.apiKey, 'test-anthropic-key');
assert.equal(config.baseUrl, 'https://api.anthropic.com');
assert.equal(config.model, 'claude-sonnet-4-6');
assert.equal(config.maxIterations, 2);

console.log('test-install-micro-agent-anthropic: ok');
