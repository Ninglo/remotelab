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
assert.equal(record.command, 'codex');
assert.equal(record.runtimeFamily, 'codex-json');
assert.equal(Object.hasOwn(record, 'promptMode'), false);
assert.equal(Object.hasOwn(record, 'flattenPrompt'), false);
assert.deepEqual(record.models, [{ id: 'gpt-5.4-mini', label: 'gpt-5.4-mini' }]);
assert.deepEqual(record.reasoning, { kind: 'none', label: 'Thinking' });

console.log('test-install-micro-agent: ok');
