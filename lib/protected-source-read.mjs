import { constants } from 'node:fs';
import { mkdir, open, readFile, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { claimOnce, readRecord } from './durable-records.mjs';

export const digest = value => createHash('sha256').update(value).digest('hex');
const fault = (code, statusCode = 403) => Object.assign(new Error(code), { code, statusCode });
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const maxBytes = 8 * 1024 * 1024;

// Local durable records for the test phase. This is not tamper-proof against
// the process owner or root; independent storage is deliberately deferred.
export function createLocalAuditWriter(directory) {
  return async event => {
    try {
      if (!/^[a-f0-9-]{36}$/.test(event.eventId)) throw new Error();
      const eventJson = JSON.stringify(event);
      const eventDigest = digest(eventJson);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const parent = await open(dirname(directory), 'r');
      try { await parent.sync(); } finally { await parent.close(); }
      const path = join(directory, `${event.eventId}.json`);
      const packet = { eventJson, digest: eventDigest };
      if (!await claimOnce(path, packet)) {
        const previous = await readRecord(path);
        if (previous?.eventJson !== eventJson || previous?.digest !== eventDigest) throw new Error();
      }
      return { stored: true, storage: 'local', eventId: event.eventId,
        receiptId: event.eventId, digest: eventDigest };
    } catch { throw fault('audit_unavailable', 503); }
  };
}

export async function loadProtectedSourcePolicy(path) {
  let value;
  try { value = JSON.parse(await readFile(path, 'utf8')); }
  catch { throw fault('protected_sources_unconfigured', 503); }
  if (value.version !== 1 || !Array.isArray(value.resources) || !Array.isArray(value.grants)
      || !id(value.policyId) || !Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw fault('invalid_source_policy', 503);
  }
  return value;
}

// The caller is resolved by the HTTP adapter, never from the payload's personId.
// Only explicitly registered immutable snapshots are supported. There is no
// wildcard/home-directory discovery and no credential or transcript collection.
export async function readProtectedSource({ policy, caller, authenticatedCaller = null, input, audit }) {
  if (typeof audit !== 'function') throw fault('audit_unavailable', 503);
  const readId = randomUUID();
  const base = { schema: 1, readId, policyId: policy.policyId, policyRevision: policy.revision,
    caller, authenticatedCaller, resourceId: id(input.resourceId) ? input.resourceId : null,
    purpose: ['query', 'context', 'export'].includes(input.purpose) ? input.purpose : null,
    requestedStart: Number.isSafeInteger(input.start) ? input.start : null,
    requestedEnd: Number.isSafeInteger(input.end) ? input.end : null };
  const emit = async fields => audit({ ...base, ...fields, eventId: randomUUID(), at: new Date().toISOString() });
  const reject = async (code, statusCode = 403) => {
    await emit({ phase: 'denied', reason: code });
    throw fault(code, statusCode);
  };
  if (!caller?.personId || !caller?.requestId || !caller?.sessionId || !caller?.runId) return reject('request_identity_required');
  if (!base.resourceId || !base.purpose || !Number.isSafeInteger(input.start) || !Number.isSafeInteger(input.end)
      || input.start < 0 || input.end <= input.start || input.end - input.start > maxBytes) return reject('invalid_read_range', 400);
  const resource = policy.resources.find(item => item.id === input.resourceId);
  if (!resource || !isAbsolute(resource.path || '') || !hash(resource.sha256)
      || !Number.isSafeInteger(resource.size) || resource.size < 1 || resource.size > maxBytes
      || input.end > resource.size) return reject('resource_not_available');
  const now = Date.now();
  const grant = policy.grants.find(item => id(item.id) && item.resourceId === resource.id
    && item.personId === caller.personId && item.sessionId === caller.sessionId
    && item.purposes?.includes(input.purpose) && typeof item.approvalRef === 'string' && item.approvalRef.trim()
    && Number.isFinite(Date.parse(item.expiresAt)) && Date.parse(item.expiresAt) > now
    && Number.isSafeInteger(item.start) && item.start >= 0 && item.start <= input.start
    && Number.isSafeInteger(item.end) && item.end <= resource.size && item.end >= input.end);
  if (!grant) return reject('read_not_granted');
  const authorization = { grantId: grant.id, approvalRef: grant.approvalRef,
    sourceVersion: resource.sha256, start: input.start, end: input.end };
  // An attempt receipt survives even if the process crashes during the read.
  await emit({ ...authorization, phase: 'authorized_attempt' });
  let file, bytes;
  try {
    // Reject symlinks in all components; the trusted snapshot directory must not
    // be writable by untrusted users (realpath alone is not a race-proof jail).
    if (await realpath(resource.path) !== resource.path) throw new Error();
    file = await open(resource.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== resource.size) throw new Error();
    bytes = Buffer.alloc(resource.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error();
      offset += bytesRead;
    }
    if (digest(bytes) !== resource.sha256) throw new Error();
  } catch {
    await emit({ ...authorization, phase: 'read_failed', reason: 'source_unavailable_or_changed' });
    throw fault('source_unavailable_or_changed', 409);
  } finally { await file?.close(); }
  // Recheck expiry after I/O. Each invocation, including retries/cache requests,
  // gets a fresh audit transaction; this function deliberately has no cache.
  if (Date.parse(grant.expiresAt) <= Date.now()) return reject('grant_expired');
  const content = bytes.subarray(input.start, input.end);
  const receipt = await emit({ ...authorization, phase: 'release_ready', bytes: content.length,
    contentDigest: digest(content) });
  if (Date.parse(grant.expiresAt) <= Date.now()) return reject('grant_expired');
  // release_ready means eligible for HTTP delivery, not proof of client receipt
  // or proof the model read/understood the bytes.
  return { readId, resourceId: resource.id, sourceVersion: resource.sha256,
    start: input.start, end: input.end, encoding: 'base64', content: content.toString('base64'), receipt };
}
