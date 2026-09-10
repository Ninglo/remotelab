import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeInputServer, submitNativeInput } from '../chat/native-input-transport.mjs';

const directory = await mkdtemp(join(tmpdir(), 'native-review-duplicate-'));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const firstCheck = deferred();
const secondCheck = deferred();
const firstGate = deferred();
const secondGate = deferred();
let checks = 0;
let calls = 0;
const server = await createNativeInputServer({ directory,
  isAccepting: async () => {
    checks++;
    if (checks === 1) { firstCheck.resolve(); await firstGate.promise; }
    else { secondCheck.resolve(); await secondGate.promise; }
    return true;
  },
  submit: async input => { calls++; return { id: input.id, accepted: true }; },
});
let first;
let second;
try {
  first = submitNativeInput(directory, { id: 'same', text: 'one side effect' });
  await firstCheck.promise;
  second = submitNativeInput(directory, { id: 'same', text: 'one side effect' });
  let timeout;
  await Promise.race([secondCheck.promise, new Promise(resolve => { timeout = setTimeout(resolve, 100); })]);
  clearTimeout(timeout);
  firstGate.resolve();
  assert.equal((await first).accepted, true);
  secondGate.resolve();
  assert.equal((await second).accepted, true);
  assert.equal(calls, 1, 'an eligibility check delayed beyond the first receipt must not dispatch its duplicate');
  console.log('native duplicate admission: asynchronous eligibility cannot reopen a completed input id');
} finally {
  firstGate.resolve(); secondGate.resolve();
  await Promise.allSettled([first, second]);
  await server.close(); await rm(directory, { recursive: true, force: true });
}
