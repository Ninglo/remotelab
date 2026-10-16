import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONFIG_DIR } from '../lib/config.mjs';
import { readBody } from '../lib/utils.mjs';
import { requests } from './requests.mjs';
import { createLocalAuditWriter, loadProtectedSourcePolicy, readProtectedSource } from '../lib/protected-source-read.mjs';

export function protectedSourceCaller(auth, record) {
  const personId = record?.options?.viewPersonId;
  if (!personId || !record?.options?.initiatedByIdentityId || record.result
      || record.options?.internalOperation || record.options?.deliveryOnly) return null;
  if (auth?.authKind !== 'service' && auth?.personId !== personId) return null;
  return { authKind: auth.authKind, personId, identityId: record.options.initiatedByIdentityId,
    sessionId: record.sessionId, requestId: record.requestId, runId: record.runId,
    attribution: auth.authKind === 'service' ? 'service_referencing_accepted_request' : 'authenticated_request_owner' };
}

export async function handleProtectedSourceRoutes({ req, res, pathname, authSession, writeJson }) {
  if (pathname !== '/api/protected-sources/read') return false;
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') { writeJson(res, 405, { error: 'POST required' }); return true; }
  const audit = createLocalAuditWriter(join(CONFIG_DIR, 'protected-source-audit'));
  const authenticatedCaller = { authKind: authSession?.authKind || 'unknown', personId: authSession?.personId || null };
  let admitted = false;
  try {
    const input = JSON.parse(await readBody(req, 8192));
    const record = typeof input.runId === 'string' ? await requests.byRunId(input.runId) : null;
    const caller = protectedSourceCaller(authSession, record);
    const policy = await loadProtectedSourcePolicy(join(CONFIG_DIR, 'protected-sources.json'));
    admitted = true;
    const result = await readProtectedSource({ policy, caller, authenticatedCaller, input, audit });
    writeJson(res, 200, result);
  } catch (error) {
    if (!admitted) {
      try {
        await audit({ schema: 1, eventId: randomUUID(), readId: randomUUID(), at: new Date().toISOString(),
          phase: 'denied', reason: 'request_or_policy_unavailable', authenticatedCaller });
      } catch { error = Object.assign(new Error(), { code: 'audit_unavailable', statusCode: 503 }); }
    }
    // Do not expose file paths, source contents, receiver bodies or credentials.
    writeJson(res, error.statusCode || 400, { error: error.code || 'invalid_read_request' });
  }
  return true;
}
