import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'remotelab-fleet-restart-'));
const bin = join(root, 'bin');
const eventsPath = join(root, 'events');
await mkdir(bin);

try {
  const fixtures = {
    uname: '#!/bin/bash\nprintf "Linux\\n"\n',
    systemctl: `#!/bin/bash
case "$1" in
  list-unit-files)
    if [[ "$2" == 'remotelab-guest@*.service' ]]; then
      printf 'remotelab-guest@trial4.service enabled\nremotelab-guest@trial23.service enabled\nremotelab-guest@trial70.service disabled\nremotelab-guest@trial95.service enabled\n'
    fi
    ;;
  list-units)
    printf 'remotelab-guest@trial23.service loaded active running\nremotelab-guest@trial70.service loaded inactive dead\n'
    ;;
  is-active)
    [[ "$3" != *trial70* && "$3" != *trial95* ]]
    ;;
  restart)
    printf 'restart %s\n' "$2" >> "$FIXTURE_EVENTS"
    [[ "$2" != "$FIXTURE_RESTART_FAIL_UNIT" ]]
    ;;
  *) exit 2 ;;
esac
`,
    node: `#!/bin/bash
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == --service-unit ]]; then
    printf 'align %s\n' "$2" >> "$FIXTURE_EVENTS"
    [[ "$2" != "$FIXTURE_ALIGN_FAIL_UNIT" ]]
    exit "$?"
  fi
  shift
done
exit 2
`,
  };
  for (const [name, contents] of Object.entries(fixtures)) {
    await writeFile(join(bin, name), contents, { mode: 0o755 });
  }
  const script = fileURLToPath(new URL('../restart.sh', import.meta.url));
  async function run(overrides = {}) {
    await writeFile(eventsPath, '');
    let status = 0;
    try {
      await exec('/bin/bash', [script, 'chat'], {
        env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, FIXTURE_EVENTS: eventsPath,
          FIXTURE_ALIGN_FAIL_UNIT: '', FIXTURE_RESTART_FAIL_UNIT: '', ...overrides },
      });
    } catch (error) { status = error.code; }
    return { status, events: (await readFile(eventsPath, 'utf8')).trim().split('\n').filter(Boolean) };
  }

  const normal = await run();
  assert.equal(normal.status, 0);
  assert.deepEqual(normal.events, [
    'align remotelab.service', 'align remotelab-guest@trial23.service', 'align remotelab-guest@trial4.service',
    'restart remotelab.service', 'restart remotelab-guest@trial23.service', 'restart remotelab-guest@trial4.service',
  ], 'all active sources must be checked before restart; disabled and enabled-but-inactive guests stay stopped');

  const drift = await run({ FIXTURE_ALIGN_FAIL_UNIT: 'remotelab-guest@trial4.service' });
  assert.notEqual(drift.status, 0);
  assert.equal(drift.events.some(event => event.startsWith('restart ')), false,
    'a source mismatch must prevent partial fleet restart');

  const failed = await run({ FIXTURE_RESTART_FAIL_UNIT: 'remotelab-guest@trial23.service' });
  assert.notEqual(failed.status, 0, 'service restart failure must propagate to the caller');
  assert.equal(failed.events.includes('restart remotelab-guest@trial4.service'), false);
  console.log('Linux chat fleet restart: shared-source preflight, inactive preservation and failure reporting passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
