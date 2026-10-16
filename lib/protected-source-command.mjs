import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONFIG_DIR } from './config.mjs';
import { requests } from '../chat/requests.mjs';
import { createLocalAuditWriter, loadProtectedSourcePolicy, readProtectedSource } from './protected-source-read.mjs';

// Instance-local execution has the same high-trust boundary as existing local
// tools. Environment/run attribution is not a credential isolating local root.
export async function runProtectedSourceCommand(args, { stdout = process.stdout, env = process.env } = {}) {
  if (!args.length || args.includes('--help')) {
    stdout.write('Usage: remotelab source-read --file <request.json> [--json]\n'
      + 'Request: {resourceId,purpose:query|context|export,start,end}. Uses the current accepted Run.\n'
      + 'Reads only registered snapshots and writes durable local audit receipts before providing data.\n'
      + 'Local audit is not tamper-proof against root; direct file access remains outside coverage.\n');
    return 0;
  }
  const audit = createLocalAuditWriter(join(CONFIG_DIR, 'protected-source-audit'));
  const authenticatedCaller = { authKind: 'local_process', uid: process.getuid?.() ?? null };
  let admitted = false;
  try {
    let file;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--json') continue;
      if (args[i] !== '--file' || file || !args[i + 1]) throw new Error();
      file = args[++i];
    }
    if (!file) throw new Error();
    const input = JSON.parse(await readFile(file, 'utf8'));
    const record = env.REMOTELAB_RUN_ID ? await requests.byRunId(env.REMOTELAB_RUN_ID) : null;
    const valid = record && !record.result && !record.options?.internalOperation && !record.options?.deliveryOnly
      && record.sessionId === env.REMOTELAB_SESSION_ID && record.options?.viewPersonId && record.options?.initiatedByIdentityId;
    const caller = valid ? { personId: record.options.viewPersonId, identityId: record.options.initiatedByIdentityId,
      runId: record.runId, sessionId: record.sessionId, requestId: record.requestId,
      authKind: 'local_process', attribution: 'local_process_referencing_accepted_request' } : null;
    const policy = await loadProtectedSourcePolicy(join(CONFIG_DIR, 'protected-sources.json'));
    admitted = true;
    const result = await readProtectedSource({ policy, caller, authenticatedCaller, input, audit });
    stdout.write(JSON.stringify(result) + '\n');
    return 0;
  } catch (error) {
    if (!admitted) {
      await audit({ schema: 1, eventId: randomUUID(), readId: randomUUID(), at: new Date().toISOString(),
        phase: 'denied', reason: 'request_or_policy_unavailable', authenticatedCaller });
    }
    throw new Error(error.code || 'invalid_read_request');
  }
}
