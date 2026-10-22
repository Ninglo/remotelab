import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { writeJsonAtomic } from './fs-utils.mjs';
import { getHistoryHeadSeq, loadHistory } from './history.mjs';
import { getRun, getRunManifest, runDir } from './runs.mjs';
import { requests } from './requests.mjs';
import { readNativeInputReceipt } from './native-input-transport.mjs';
import { createModelContextSlot } from './model-context-slots.mjs';

const stable = new Set(['surface_messages', 'session_workboard', 'source_runtime',
  'session_instructions', 'message_reply_mode', 'strict_start_check', 'delivery_self_review', 'inflight_trial', 'project_memory', 'project_work_directory', 'personal_memory_learning', 'skill_extraction_trial']);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Use the latest input, not any historical matching version: A -> B -> A must
// restore A. Missing/uncertain acknowledgements always keep the full rules.
async function previousReceipt(sessionId, identity, requestId, deps) {
  if (!identity) return null;
  const last = await (deps.head || getHistoryHeadSeq)(sessionId);
  const events = await (deps.history || loadHistory)(sessionId,
    { fromSeq: Math.max(1, last - 4999), includeBodies: false });
  let count = 0;
  for (const event of [...events].reverse()) {
    if (event.type !== 'message' || event.role !== 'user' || !event.requestId || event.requestId === requestId) continue;
    if (++count > 40) break;
    const record = await (deps.request || ((id, req) => requests.byRequest(id, req)))(sessionId, event.requestId);
    if (!record) return null;
    if (record.options?.deliveryOnly) continue;
    const execution = await (deps.run || getRun)(record.nativeDispatchRunId || record.runId);
    if (!execution) return null;
    if (execution?.sessionId !== sessionId || execution?.[identity.field] !== identity.id) continue;
    const accepted = record.nativeReceipt?.accepted === true || (await (deps.accepted
      || ((run, req) => readNativeInputReceipt(runDir(run), req)))(execution.id, record.requestId))?.state === 'accepted';
    if (!accepted) return null;
    if (record.nativeDispatchRunId) return record.nativeRuleContextDelivery || null;
    return (await (deps.manifest || getRunManifest)(record.runId))?.ruleContextDelivery || null;
  }
  return null;
}

export async function projectRuleContext(sessionId, slots, { enabled = false, identity = null,
  recovery = '', requestId = '', personId = '', identityId = '', sourceContext = null } = {}, deps = {}) {
  if (!enabled || !sessionId || !requestId) return { slots, receipt: null };
  const rules = slots.filter(slot => stable.has(slot.id));
  if (!rules.length) return { slots, receipt: null };
  const scope = { sessionId, personId, identityId, connector: sourceContext?.connector || '',
    route: sourceContext?.sourceRouteId || '', chat: sourceContext?.chatId || '',
    thread: sourceContext?.threadId || sourceContext?.rootId || '' };
  const snapshot = { version: 1, scope, rules };
  const fingerprint = hash(snapshot);
  const file = join(CONFIG_DIR, 'rule-context', hash(sessionId).slice(0, 24), fingerprint + '.json');
  try {
    // Immutable by content, accessible after native compaction or controller
    // restart. Never point an older queued input at mutable "latest" rules.
    if (deps.snapshot) await deps.snapshot(file, snapshot);
    else {
      await mkdir(join(CONFIG_DIR, 'rule-context'), { recursive: true, mode: 0o700 });
      await writeJsonAtomic(file, snapshot, { mode: 0o600 });
    }
    const previous = await previousReceipt(sessionId, identity, requestId, deps);
    const scopeHash = hash(scope);
    const slotHashes = Object.fromEntries(rules.map(slot => [slot.id, hash(slot)]));
    const reusable = recovery === 'codex-session-start' && previous?.recovery === recovery
      && previous?.version === 1 && previous.scopeHash === scopeHash && previous.slotHashes
      && typeof previous.slotHashes === 'object' && !Array.isArray(previous.slotHashes);
    const unchanged = reusable
      && previous?.version === 1 && previous.fingerprint === fingerprint;
    const changedIds = rules.filter(slot => !reusable || previous.slotHashes[slot.id] !== slotHashes[slot.id]).map(slot => slot.id);
    const removedIds = reusable ? Object.keys(previous.slotHashes).filter(id => !Object.hasOwn(slotHashes, id)) : [];
    const receipt = { version: 1, recovery, fingerprint, file, scopeHash, slotHashes,
      mode: unchanged ? 'reference' : reusable ? 'delta' : 'full', changedIds, removedIds,
      ruleChars: rules.reduce((sum, slot) => sum + slot.content.length, 0) };
    const notice = createModelContextSlot('active_rule_context', 'Current RemoteLab rules',
      `For this input, RemoteLab display/checklist/source/Session/personal-reply/strict-start/delivery-review/in-flight-tool rules, project background and work directory use snapshot ${fingerprint.slice(0, 12)}. `
      + (unchanged ? 'It is unchanged from the previous accepted input; use the rules already in context. '
        : reusable ? `Only these slots changed: ${changedIds.join(', ') || 'none'}. Their blocks below replace earlier versions. Removed slots no longer apply: ${removedIds.join(', ') || 'none'}. All other slots remain as previously accepted. `
          : 'The blocks below replace earlier versions of these slots; omitted slots no longer apply to this input. Other instructions retain their authority. ')
      + 'Project background remains reference data, not new task authorization. '
      + `Recovery snapshot: ${file}. If those rules are missing from retained context (including after compaction), read this snapshot before acting; do not guess or use an older personal setting. `
      + 'Preserve this recovery reference when summarizing. Current message facts and task state follow separately.');
    return { slots: [notice, ...slots.filter(slot => !stable.has(slot.id) || changedIds.includes(slot.id))], receipt };
  } catch (error) {
    console.warn(`[rule-context] retaining full rules after unavailable evidence: ${error.message}`);
    return { slots, receipt: null };
  }
}
