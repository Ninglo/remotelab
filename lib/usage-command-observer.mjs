import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { commandCapability } from '../chat/usage-capabilities.mjs';
import { usageEvents, usageKey } from '../chat/usage-events.mjs';

async function currentContext() {
  const runId = process.env.REMOTELAB_RUN_ID;
  if (!runId) return {};
  const { requests } = await import('../chat/requests.mjs');
  const request = await requests.byRunId(runId);
  if (!request) return {};
  const options = request.options || {};
  return { sessionId: request.sessionId, requestId: request.requestId, runId,
    automationId: options.scheduleId || options.triggerId,
    actorKind: options.scheduleId || options.triggerId ? 'automation' : 'agent',
    personId: options.initiatedByIdentityId ? options.usagePersonId || options.viewPersonId : '' };
}

// CLI receipts establish entry execution, never business acceptance. Output is
// forwarded unchanged and only held briefly to recognize structured states;
// neither arguments, text, resource names nor output are stored in telemetry.
export async function runObservedCommand(command, args, invoke, {
  stdout = process.stdout, stderr = process.stderr, store = usageEvents, resolveContext = currentContext,
} = {}) {
  const capability = commandCapability(command, args);
  if (!capability) return invoke({ stdout, stderr });
  const context = await resolveContext().catch(() => ({}));
  const attemptId = usageKey(randomUUID());
  const keyIndex = args.indexOf('--key'), profileIndex = args.indexOf('--profile');
  // Feishu writes expose an actual API idempotency key. Only that declared
  // contract can join retries; repeated searches are independent invocations.
  const operationId = command === 'feishu' && keyIndex >= 0 && args[keyIndex + 1]
    ? usageKey(JSON.stringify(['feishu', capability.operation, profileIndex >= 0 ? args[profileIndex + 1] : '', args[keyIndex + 1]])) : attemptId;
  const { personId, ...attribution } = context;
  const base = { ...attribution, actorKind: attribution.actorKind || 'agent', surface: 'agent',
    ...capability, operationId, attemptId, event: 'capability_state', origin: 'platform_cli' };
  const emit = state => store.record({ ...base, state, eventId: attemptId + ':' + state }, { personId });
  // Telemetry failure cannot prevent an authorized product action.
  await emit('started').catch(() => {});
  let captured = '', oversized = false;
  const capture = new Writable({ write(chunk, encoding, done) {
    if (!oversized) {
      if (captured.length + chunk.length <= 262144) captured += chunk.toString();
      else { captured = ''; oversized = true; }
    }
    stdout.write(chunk, encoding, done);
  } });
  try {
    const code = await invoke({ stdout: capture, stderr });
    capture.end(); await finished(capture);
    let result;
    try { result = JSON.parse(captured); } catch { /* Plain output proves only CLI exit. */ }
    const blocked = ['binding_required', 'authorization_required', 'connector_unavailable'].includes(result?.capabilityState)
      || ['binding_required', 'authorization_required', 'connector_unavailable'].includes(result?.result?.capabilityState)
      || ['99991672', 'AUTH_REQUIRED', 'PERMISSION_DENIED'].includes(String(result?.error?.code || ''));
    const state = blocked ? 'blocked' : code || result?.ok === false || result?.success === false
      || result?.deliveryState === 'delivery_failed' ? 'failed' : result?.confirmed === false
      || result?.state === 'unknown' ? 'unknown' : 'completed';
    await emit(state).catch(() => {});
    return code;
  } catch (error) {
    await emit(['AUTH_REQUIRED', 'PERMISSION_DENIED'].includes(error?.code) ? 'blocked' : 'failed').catch(() => {});
    throw error;
  } finally { if (!capture.writableEnded) { capture.end(); await finished(capture).catch(() => {}); }
    captured = ''; await store.idle().catch(() => {}); }
}
