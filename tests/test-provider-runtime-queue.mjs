#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  acquireProviderRuntimeLease,
  resolveProviderRuntimeQueueKey,
} from '../chat/provider-runtime-queue.mjs';

assert.equal(
  resolveProviderRuntimeQueueKey({ runtimeFamily: 'pi-json', provider: 'moonshotai' }, {}),
  'pi-json:moonshotai',
  'Moonshot Pi runs should serialize by default because the provider account can expose concurrency one',
);
assert.equal(
  resolveProviderRuntimeQueueKey({ runtimeFamily: 'pi-json', provider: 'openai' }, {}),
  '',
  'unlisted providers should keep their normal concurrency',
);
assert.equal(
  resolveProviderRuntimeQueueKey(
    { runtimeFamily: 'pi-json', provider: 'moonshotai' },
    { REMOTELAB_SERIAL_PROVIDER_RUNTIMES: '' },
  ),
  '',
  'an explicit empty runtime list should disable serialization',
);

const rootDir = await mkdtemp(join(tmpdir(), 'remotelab-provider-runtime-queue-test-'));
try {
  const first = await acquireProviderRuntimeLease({
    queueKey: 'pi-json:moonshotai',
    runId: 'run_first',
    rootDir,
    pollIntervalMs: 10,
  });
  assert.ok(first);
  assert.equal(first.waited, false);

  let secondAcquired = false;
  let secondWaitNotices = 0;
  const secondPromise = acquireProviderRuntimeLease({
    queueKey: 'pi-json:moonshotai',
    runId: 'run_second',
    rootDir,
    pollIntervalMs: 10,
    onWait: async () => {
      secondWaitNotices += 1;
    },
  }).then((lease) => {
    secondAcquired = true;
    return lease;
  });

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(secondAcquired, false, 'a second run should wait while the provider lease is active');
  assert.equal(secondWaitNotices, 1, 'queue waiting should emit one diagnostic notification');

  await first.release();
  const second = await secondPromise;
  assert.equal(second.waited, true);
  assert.equal(secondAcquired, true);
  await second.release();

  const staleRoot = join(rootDir, 'stale');
  const stale = await acquireProviderRuntimeLease({
    queueKey: 'pi-json:moonshotai',
    runId: 'run_stale',
    rootDir: staleRoot,
    isProcessAlive: () => false,
  });
  assert.ok(stale);
  // Leave the first lease directory in place and prove a new process can
  // recover it when neither the sidecar nor tool process is alive.
  const recovered = await acquireProviderRuntimeLease({
    queueKey: 'pi-json:moonshotai',
    runId: 'run_recovered',
    rootDir: staleRoot,
    pollIntervalMs: 10,
    isProcessAlive: () => false,
  });
  assert.ok(recovered);
  await recovered.release();
} finally {
  await rm(rootDir, { recursive: true, force: true });
}

console.log('test-provider-runtime-queue: ok');
