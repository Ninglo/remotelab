#!/usr/bin/env node
import { execFile } from 'child_process';
import { homedir } from 'os';
import { promisify } from 'util';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import {
  ensureCliAlignment,
  parseSystemdShow,
  validateServiceAlignment,
} from '../lib/runtime-alignment.mjs';

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, '..');

function readOption(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  return String(process.argv[index + 1] || '').trim() || fallback;
}

const mode = readOption('--mode', 'check');
const serviceScope = readOption(
  '--service-scope',
  process.platform === 'linux' ? 'system' : 'none',
);
const serviceUnit = readOption('--service-unit', 'remotelab.service');

try {
  const cli = await ensureCliAlignment({
    repoRoot,
    homeDir: process.env.HOME || homedir(),
    pathValue: process.env.PATH,
  });

  let service = null;
  if (
    process.platform === 'linux'
    && serviceScope !== 'none'
    && process.env.REMOTELAB_RUNTIME_ALIGNMENT_SKIP_SERVICE !== '1'
  ) {
    const args = [];
    if (serviceScope === 'user') args.push('--user');
    args.push(
      'show',
      serviceUnit,
      '--property=FragmentPath',
      '--property=WorkingDirectory',
      '--property=ExecStart',
    );
    const { stdout } = await execFileAsync('systemctl', args, { encoding: 'utf8' });
    service = validateServiceAlignment({
      repoRoot,
      serviceState: parseSystemdShow(stdout),
    });
  }

  const changes = cli.changedPaths.length > 0
    ? `corrected ${cli.changedPaths.join(', ')}`
    : 'already aligned';
  const serviceSummary = service
    ? `; service=${serviceUnit}:${service.workingDirectory}`
    : '';
  const warning = cli.warning ? `; warning=${cli.warning}` : '';
  console.log(`Runtime alignment (${mode}): ${changes}${serviceSummary}${warning}`);
} catch (error) {
  console.error(`Runtime alignment failed: ${error.message || String(error)}`);
  process.exitCode = 1;
}
