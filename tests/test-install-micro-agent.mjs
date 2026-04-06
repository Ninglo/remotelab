import assert from 'assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

const repoRoot = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), 'install-micro-agent-'));
const homeDir = join(tempRoot, 'home');

mkdirSync(join(homeDir, '.codex'), { recursive: true });
writeFileSync(join(homeDir, '.codex', 'config.toml'), 'model = "gpt-5.4-mini"\n', 'utf8');

const result = spawnSync('node', ['scripts/install-micro-agent.mjs', '--tool-id', 'micro-agent-test', '--tool-name', 'Micro Agent Test'], {
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
const record = tools.find((tool) => tool.id === 'micro-agent-test');

assert(record, 'installed tool should exist');
assert.equal(record.name, 'Micro Agent Test');
assert.equal(record.toolProfile, 'micro-agent');
assert.equal(record.visibility, 'private');
assert.match(record.command, /scripts\/micro-agent-router\.mjs$/);
assert.equal(record.runtimeFamily, 'claude-stream-json');
assert.equal(record.promptMode, 'bare-user');
assert.equal(record.flattenPrompt, true);
assert.deepEqual(record.models, [
  {
    id: 'gpt-5.4-mini',
    label: 'gpt-5.4-mini',
    reasoningKind: 'enum',
    supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh'],
    defaultReasoning: 'medium',
  },
  {
    id: 'opus',
    label: 'Claude Opus',
    reasoningKind: 'enum',
    supportedReasoningLevels: ['low', 'medium', 'high'],
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
    id: 'doubao-seed-2-0-pro-260215',
    label: 'Doubao Pro',
  },
]);
assert.deepEqual(record.reasoning, {
  kind: 'none',
  label: 'Thinking',
});

console.log('test-install-micro-agent: ok');
