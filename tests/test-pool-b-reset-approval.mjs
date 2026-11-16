#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  approveAndConsumePoolBReset,
  createPoolBResetRequest,
  formatPoolBResetApprovalMessage,
  loadPoolBResetRequest,
  parsePoolBResetApprovalCommand,
} from '../lib/pool-b-reset-approval.mjs';

const stateDir = await mkdtemp(join(tmpdir(), 'remotelab-pool-b-reset-'));
const requester = { openId: 'ou_owner', userId: 'u_owner', name: '张思源' };
const request = await createPoolBResetRequest({
  stateDir,
  account: 'codex_a_4',
  accountLabel: 'Lucysw',
  chatId: 'oc_group',
  threadId: 'omt_topic',
  requester,
  reason: '容量失败补救测试',
  cardsAvailable: 2,
});

assert.match(request.requestId, /^rb-reset-[a-f0-9]{12}$/);
assert.equal(request.status, 'pending');
assert.match(formatPoolBResetApprovalMessage(request), new RegExp(request.requestId));
assert.deepEqual(parsePoolBResetApprovalCommand(`批准 Reset ${request.requestId}`), {
  type: 'approve_pool_b_reset',
  requestId: request.requestId,
});
assert.deepEqual(parsePoolBResetApprovalCommand(`@_bot 批准 Reset ${request.requestId}`), {
  type: 'approve_pool_b_reset',
  requestId: request.requestId,
});
assert.deepEqual(parsePoolBResetApprovalCommand(`拒绝 Reset ${request.requestId}`), {
  type: 'reject_pool_b_reset',
  requestId: request.requestId,
});

let calls = 0;
const approvedAndConsumed = await approveAndConsumePoolBReset({
  stateDir,
  requestId: request.requestId,
  approver: requester,
  chatId: 'oc_group',
  threadId: 'omt_topic',
  runner: async (args) => {
    calls += 1;
    assert.deepEqual(args, [
      '--account', 'codex_a_4',
      '--idempotency-key', request.idempotencyKey,
      '--confirm',
    ]);
    return { code: 0, stdout: 'reset accepted', stderr: '' };
  },
});
assert.equal(calls, 1);
assert.equal(approvedAndConsumed.status, 'consumed');
assert.equal((await loadPoolBResetRequest(stateDir, request.requestId)).status, 'consumed');

const persisted = JSON.parse(await readFile(join(stateDir, `${request.requestId}.json`), 'utf8'));
assert.equal(persisted.receipt.stdout, 'reset accepted');

let duplicateRunnerCalls = 0;
const duplicate = await approveAndConsumePoolBReset({
    stateDir,
    requestId: request.requestId,
    approver: { openId: 'ou_other' },
    chatId: 'oc_group',
    threadId: 'omt_topic',
    runner: async () => { duplicateRunnerCalls += 1; return { code: 0 }; },
  });
assert.equal(duplicate.status, 'consumed');
assert.equal(duplicateRunnerCalls, 0);

console.log('pool-b reset approval tests passed');
