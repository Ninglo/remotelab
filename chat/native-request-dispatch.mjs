import { submitNativeInput, readNativeInputReceipt } from './native-input-transport.mjs';

const terminal = run => ['completed', 'failed', 'cancelled'].includes(run?.state);
const now = () => new Date().toISOString();

// Each pending promise waits only for a native input receipt. It never prevents
// the next input from reaching the same Harness, including Claude's delayed ack.
export function createNativeRequestDispatcher({ store, getRun, getManifest, runDirectory, prepareInput, recordInput, settle, changed, onError, reject: rejectInput }) {
  const tasks = new Map();
  const reject = rejectInput || (async (record, error) => {
    await store.settle(record.key, { state: 'failed', payload: null, error });
    await store.mutate(record.key, current => ({ ...current, releasedAt: now(), postCompletionPending: false }));
  });
  const clear = record => store.mutate(record.key, current => ({ ...current, nativeDispatchRunId: null, nativeInput: null, nativeReceipt: null }));
  const send = async record => {
    const rootId = record.nativeDispatchRunId;
    const run = await getRun(rootId);
    const receipt = await readNativeInputReceipt(runDirectory(rootId), record.requestId);
    if (record.nativeReceipt || receipt?.state === 'accepted') {
      if (!record.nativeReceipt) record = await store.mutate(record.key, current => ({ ...current, nativeReceipt: receipt.result, preparedAt: current.preparedAt || now() }));
      await settle(record, run);
      return;
    }
    if (run?.cancelRequested && !receipt) { await clear(record); return; }
    if (terminal(run)) {
      if (!receipt) { await clear(record); return; }
      await reject(record, receipt.error || 'Native input acknowledgement was lost; automatic replay was suppressed.');
      return;
    }
    try {
      const result = await submitNativeInput(runDirectory(rootId), record.nativeInput);
      if (!result?.accepted) { await clear(record); return; }
      record = await store.mutate(record.key, current => ({ ...current, nativeReceipt: result, preparedAt: current.preparedAt || now() }));
      await settle(record, await getRun(rootId));
    } catch (error) {
      // A missing endpoint is normal while a detached runner initializes. A
      // receipt with unknown outcome remains attached and can only be queried,
      // never converted into a fresh model run.
      if (error.code === 'NATIVE_REJECTED' || error.code === 'NATIVE_CONFLICT') { await reject(record, error.message); return; }
      if (!['NATIVE_UNAVAILABLE', 'NATIVE_UNCERTAIN'].includes(error.code)) throw error;
    }
  };
  return {
    async forward(record, head) {
      if (record.releasedAt || record.result || tasks.has(record.key)) return;
      if (!record.nativeDispatchRunId) {
        if (!head || record.key === head.key || record.preparedAt || record.options.freshThread || head.cancelRequestedAt || record.options.internalOperation || head.options?.internalOperation) return;
        const manifest = await getManifest(head.runId);
        if (manifest?.inputMode !== 'native') return;
        if ((await getRun(head.runId))?.cancelRequested) return;
        const a = record.runtimeSelection || {};
        const b = head.runtimeSelection || {};
        if (['tool', 'model', 'effort', 'thinking'].some(key => (a[key] || '') !== (b[key] || ''))) return;
        const prepared = await prepareInput(record, manifest);
        const text = typeof prepared === 'string' ? prepared : prepared.text;
        const context = typeof prepared === 'string' ? '' : prepared.context || '';
        record = await store.mutate(record.key, current => ({ ...current,
          nativeDispatchRunId: head.runId, nativeInput: { id: record.requestId, text }, nativeContext: context,
        }));
        await changed(record.key);
      }
      await recordInput(record, { managerTurnContext: record.nativeContext || '' });
      const task = send(record).catch(error => onError(error, record.sessionId))
        .finally(async () => { await changed(record.key); tasks.delete(record.key); });
      tasks.set(record.key, task);
    },
    async idle() { await Promise.all(tasks.values()); },
  };
}
