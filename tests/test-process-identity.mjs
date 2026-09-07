import assert from 'node:assert/strict';
import { readProcessIdentity, isProcessIdentityAlive } from '../lib/process-identity.mjs';
const identity = await readProcessIdentity(process.pid);
assert.ok(identity.birth);
assert.equal(await isProcessIdentityAlive(identity), true);
assert.equal(await isProcessIdentityAlive({ ...identity, birth: 'previous process using same PID' }), false);
assert.equal(await isProcessIdentityAlive(null), false);
console.log('process identity: live executor is distinguished from a recycled PID');
