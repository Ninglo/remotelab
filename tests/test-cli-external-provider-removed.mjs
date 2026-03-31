#!/usr/bin/env node
import assert from 'assert/strict';
import { spawnSync } from 'child_process';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

for (const command of ['solution-provider', 'evomap-gep']) {
  const result = spawnSync(process.execPath, ['cli.js', command], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1, `${command} should exit non-zero`);
  assert.match(result.stderr, /Unknown command/i, `${command} should be rejected as unknown`);
}

const helpResult = spawnSync(process.execPath, ['cli.js', '--help'], {
  cwd: repoRoot,
  encoding: 'utf8',
});

assert.equal(helpResult.status, 0, 'help should succeed');
assert.doesNotMatch(helpResult.stdout, /solution-provider/i, 'help should not mention removed solution-provider command');
assert.doesNotMatch(helpResult.stdout, /evomap-gep/i, 'help should not mention removed evomap-gep command');

console.log('test-cli-external-provider-removed: ok');
