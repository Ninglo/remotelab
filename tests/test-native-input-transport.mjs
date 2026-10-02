import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeInputServer, submitNativeInput, readNativeInputReceipt, readNativeUsage } from '../chat/native-input-transport.mjs';

const directory = await mkdtemp(join(tmpdir(), 'native-input-test-'));
let accepting = true;
let calls = 0;
let unblock;
const blocked = new Promise(resolve => { unblock = resolve; });
const server = await createNativeInputServer({ directory, isAccepting: () => accepting,
  submit: async input => { calls++; await blocked; return { accepted: true, id: input.id }; },
});
try {
  const first = submitNativeInput(directory, { id: 'one', text: 'change direction' });
  while (!(await readNativeInputReceipt(directory, 'one'))) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await readNativeInputReceipt(directory, 'one')).state, 'dispatching');
  const duplicate = submitNativeInput(directory, { id: 'one', text: 'change direction' });
  unblock();
  assert.equal((await first).accepted, true);
  assert.equal((await duplicate).accepted, true);
  assert.equal(calls, 1, 'retry cannot resend an already dispatched native input');
  await assert.rejects(submitNativeInput(directory, { id: 'one', text: 'different' }), /different content/);
  accepting = false;
  assert.equal((await submitNativeInput(directory, { id: 'two', text: 'later' })).accepted, false);
  assert.equal(await readNativeInputReceipt(directory, 'two'), null, 'declined inputs must be safe for a new run');
  await server.close();
  assert.equal((await submitNativeInput(directory, { id: 'one', text: 'change direction' })).accepted, true, 'durable receipt survives host exit');
  await assert.rejects(submitNativeInput(directory, { id: 'three', text: 'later' }), { code: 'NATIVE_UNAVAILABLE' });
  console.log('native transport: immediate handoff, concurrent dedupe, durable acknowledgement, safe close passed');
} finally { await server.close(); await rm(directory, { recursive: true, force: true }); }

const quotaDirectory = await mkdtemp(join(tmpdir(), 'native-usage-test-'));
let releaseQuota, quotaStarted;
const reading = new Promise(resolve => { quotaStarted = resolve; });
const quota = new Promise(resolve => { releaseQuota = resolve; });
let inputCalls = 0;
const quotaServer = await createNativeInputServer({ directory:quotaDirectory, isAccepting:() => true,
  readUsage:() => { quotaStarted(); return quota; },
  submit:async input => { inputCalls++; return {accepted:true,id:input.id}; },
});
try {
  const pendingQuota = readNativeUsage(quotaDirectory);
  await reading;
  assert.equal(quotaServer.pending, 0, 'observations do not own model-input capacity');
  assert.equal((await submitNativeInput(quotaDirectory, {id:'normal',text:'normal task'})).accepted, true);
  assert.equal(inputCalls, 1, 'a pending quota request never delays normal input');
  releaseQuota({status:'ready',buckets:[]});
  assert.deepEqual(await pendingQuota, {status:'ready',buckets:[]});
  assert.equal(await readNativeInputReceipt(quotaDirectory, 'read-usage'), null,
    'read-only requests never create input receipts');
} finally { releaseQuota({}); await quotaServer.close(); await rm(quotaDirectory, {recursive:true,force:true}); }
