#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const expectedVersion = packageJson.dependencies['@larksuite/cli'];
const larkCliPath = fileURLToPath(new URL('../node_modules/.bin/lark-cli', import.meta.url));

function run(args) {
  return new Promise((resolve, reject) => {
    execFile(larkCliPath, args, {
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
      },
    }, (error, stdout = '', stderr = '') => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(`${stdout}${stderr}`);
    });
  });
}

const version = await run(['--version']);
assert.match(version, new RegExp(`lark-cli version ${expectedVersion.replaceAll('.', '\\.')}`));

const fetchHelp = await run(['docs', '+fetch', '--help']);
for (const required of [
  '--as string',
  '--scope string',
  '--detail string',
  '--doc-format string',
  '--start-block-id string',
  '--end-block-id string',
  '--keyword string',
  '--context-before int',
  '--context-after int',
  '--max-depth int',
]) {
  assert.match(fetchHelp, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}
assert.match(fetchHelp, /full\|outline\|range\|keyword\|section/);

const mediaHelp = await run(['docs', '+media-download', '--help']);
for (const required of ['--as string', '--output string', '--token string', '--type string', '--overwrite']) {
  assert.match(mediaHelp, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

const configHelp = await run(['config', 'init', '--help']);
for (const required of ['--app-id string', '--app-secret-stdin', '--brand string']) {
  assert.match(configHelp, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

console.log('test-feishu-lark-cli-contract: ok');
