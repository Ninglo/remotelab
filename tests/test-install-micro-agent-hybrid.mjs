import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

const repoRoot = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), 'install-micro-agent-hybrid-'));
const homeDir = join(tempRoot, 'home');

mkdirSync(join(homeDir, '.codex'), { recursive: true });
writeFileSync(join(homeDir, '.codex', 'config.toml'), 'model = "gpt-5.4-mini"\n', 'utf8');

const result = spawnSync('node', ['scripts/install-micro-agent.mjs'], {
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

assert(record, 'installed hybrid micro-agent tool should exist');
assert.equal(record.name, 'Micro Agent');
assert.equal(record.toolProfile, 'micro-agent');
assert.equal(record.visibility, 'private');
assert.match(record.command, /scripts\/micro-agent-router\.mjs$/);
assert.equal(record.runtimeFamily, 'claude-stream-json');
assert.equal(record.promptMode, 'bare-user');
assert.equal(record.flattenPrompt, true);
assert.deepEqual(record.models, [
  { id: 'gpt-5.4-mini', label: 'gpt-5.4-mini' },
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
]);
assert.deepEqual(record.reasoning, {
  kind: 'none',
  label: 'Thinking',
});

console.log('test-install-micro-agent-hybrid: ok');
