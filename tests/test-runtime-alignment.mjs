#!/usr/bin/env node
import assert from 'assert/strict';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  ensureCliAlignment,
  parseSystemdShow,
  validateServiceAlignment,
} from '../lib/runtime-alignment.mjs';

const tempRoot = mkdtempSync(join(tmpdir(), 'remotelab-runtime-alignment-'));
const repoRoot = join(tempRoot, 'active repo');
const staleRoot = join(tempRoot, 'stale repo');
const homeDir = join(tempRoot, 'home');
const pathBin = join(tempRoot, 'path-bin');

for (const directory of [repoRoot, staleRoot, homeDir, pathBin]) {
  mkdirSync(directory, { recursive: true });
}

const activeCli = join(repoRoot, 'cli.js');
const activeServer = join(repoRoot, 'chat-server.mjs');
const staleCli = join(staleRoot, 'cli.js');
writeFileSync(activeCli, '#!/usr/bin/env node\n');
writeFileSync(activeServer, '#!/usr/bin/env node\n');
writeFileSync(staleCli, '#!/usr/bin/env node\n');
chmodSync(activeCli, 0o755);
chmodSync(activeServer, 0o755);
chmodSync(staleCli, 0o755);

const effectiveCli = join(pathBin, 'remotelab');
symlinkSync(staleCli, effectiveCli);

const first = await ensureCliAlignment({
  repoRoot,
  homeDir,
  pathValue: pathBin,
});

const localShim = join(homeDir, '.local', 'bin', 'remotelab');
assert.equal(realpathSync(effectiveCli), realpathSync(activeCli));
assert.equal(realpathSync(localShim), realpathSync(activeCli));
assert.equal(lstatSync(effectiveCli).isSymbolicLink(), true);
assert.equal(lstatSync(localShim).isSymbolicLink(), true);
assert.deepEqual(
  first.changedPaths.sort(),
  [effectiveCli, localShim].sort(),
  'first convergence should repair both the effective CLI and the local shim',
);

const second = await ensureCliAlignment({
  repoRoot,
  homeDir,
  pathValue: pathBin,
});
assert.deepEqual(second.changedPaths, [], 'second convergence must be idempotent');

const serviceState = parseSystemdShow([
  `FragmentPath=/etc/systemd/system/remotelab.service`,
  `WorkingDirectory=${repoRoot}`,
  `ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node ${activeServer} ; }`,
].join('\n'));

assert.deepEqual(validateServiceAlignment({ repoRoot, serviceState }), {
  fragmentPath: '/etc/systemd/system/remotelab.service',
  workingDirectory: repoRoot,
  serverPath: activeServer,
});

assert.throws(
  () => validateServiceAlignment({
    repoRoot,
    serviceState: {
      ...serviceState,
      WorkingDirectory: staleRoot,
      ExecStart: `/usr/bin/node ${join(staleRoot, 'chat-server.mjs')}`,
    },
  }),
  /does not match the active checkout/,
  'restart must fail before booting a service from a different checkout',
);

console.log('test-runtime-alignment: ok');
