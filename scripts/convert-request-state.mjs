#!/usr/bin/env node
// Deployment-only converter. Never imported by the server or connector.
import { cp, mkdir, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { readRecord, writeDurableJson } from '../lib/durable-records.mjs';

const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
if (!args.includes('--source') || !args.includes('--output')) {
  console.error('Usage: node scripts/convert-request-state.mjs --source <stopped-config> --output <new-staging-directory> [--interrupt-unfinished]');
  process.exit(1);
}
const source = resolve(option('--source'));
const output = resolve(option('--output'));
if (source === output || output.startsWith(`${source}/`)) throw new Error('Output must be a separate new staging directory');
await mkdir(output); // Refuse to overwrite any previous conversion.
for (const name of await readdir(source)) {
  await cp(join(source, name), join(output, name), { recursive: true, force: false, errorOnExist: true });
}
process.env.REMOTELAB_CONFIG_DIR = output;
delete process.env.REMOTELAB_INSTANCE_ROOT;
const { createRequestStore } = await import('../chat/requests.mjs');
const { buildReplyPublicationPayload, collectReplyPublicationHistory } = await import('../chat/reply-publication.mjs');
const { buildReplyDeliveries, normalizeSourceDeliveryPlan } = await import('../chat/source-deliveries.mjs');
const { loadHistory } = await import('../chat/history.mjs');
const store = createRequestStore(join(output, 'requests'));
const report = { schema: 1, source, output, runs: [], queued: [], deliveries: [], warnings: [] };
const sessionData = await readRecord(join(output, 'chat-sessions.json')) || [];
const sessions = Array.isArray(sessionData) ? sessionData : sessionData.sessions || [];
const sessionById = new Map(sessions.map(session => [session.id, session]));
const runIds = (await readdir(join(output, 'chat-runs')).catch(error => {
  if (error.code === 'ENOENT') return [];
  throw error;
})).filter(name => /^run_/.test(name));
const unfinished = [];
for (const id of runIds) {
  const run = await readRecord(join(output, 'chat-runs', id, 'status.json'));
  if (run && !['completed', 'failed', 'cancelled'].includes(run.state)) unfinished.push(id);
}
if (unfinished.length && !args.includes('--interrupt-unfinished')) {
  await writeDurableJson(join(output, 'conversion-report.json'), { ...report, unfinished });
  throw new Error('Unfinished attempts require explicit disposition. Wait for them to finish or use --interrupt-unfinished after stopping their executors. Source is unchanged.');
}
for (const id of runIds) {
  const dir = join(output, 'chat-runs', id);
  let run = await readRecord(join(dir, 'status.json'));
  if (!run) throw new Error(`Missing status: ${id}`);
  const manifest = await readRecord(join(dir, 'manifest.json'));
  if (!manifest) throw new Error(`Missing manifest: ${id}`);
  const history = await loadHistory(run.sessionId, { includeBodies: true });
  const user = history.find(event => event.runId === id && event.type === 'message' && event.role === 'user');
  const requestId = run.requestId || `historical:${id}`;
  const previous = await store.byRequest(run.sessionId, requestId);
  if (previous) throw new Error(`Multiple attempts share request identity ${run.sessionId}/${requestId}; reconcile explicitly before conversion`);
  const options = { ...manifest.options, requestId, responseId: run.responseId || requestId,
    tool: manifest.tool || run.tool, sourceContext: user?.sourceContext,
    sourceDelivery: manifest.sourceDelivery, internalOperation: manifest.internalOperation,
    triggerId: manifest.triggerId, scheduleId: manifest.scheduleId, occurrenceId: manifest.occurrenceId,
    recordUserMessage: !!user };
  const { record } = await store.accept({ sessionId: run.sessionId, requestId, runId: id,
    text: user?.content || manifest.prompt || '[historical request]', images: manifest.options?.images || [], options });
  if (unfinished.includes(id)) {
    run = { ...run, state: 'failed', completedAt: new Date().toISOString(),
      failureReason: 'Execution interrupted during explicit offline conversion; not automatically replayed' };
    await writeDurableJson(join(dir, 'result.json'), { exitCode: 1, completedAt: run.completedAt, error: run.failureReason });
  }
  const payload = buildReplyPublicationPayload(collectReplyPublicationHistory(history, run), run, {
    session: sessionById.get(run.sessionId), fullHistory: history,
  });
  // Old ordinary replies had no reliable outbox. Never infer permission to resend them.
  await store.settle(record.key, { state: run.state, payload, error: run.failureReason || null }, []);
  await store.mutate(record.key, current => ({ ...current, releasedAt: run.completedAt || new Date().toISOString(), postCompletionPending: false }));
  await store.archiveFinished(record.key);
  delete run.replyPublication; delete run.replyPublicationRootRunId;
  await writeDurableJson(join(dir, 'status.json'), run);
  report.runs.push({ id, requestId, state: run.state });
}
for (const session of sessions) {
  for (const entry of session.followUpQueue || []) {
    const { record } = await store.accept({ sessionId: session.id, requestId: entry.requestId,
      text: entry.text, images: entry.images || [], options: { ...entry, responseId: entry.responseId || entry.requestId } });
    report.queued.push({ sessionId: session.id, requestId: record.requestId });
  }
  delete session.followUpQueue; delete session.recentFollowUpRequestIds; delete session.activeRunId;
}
await writeDurableJson(join(output, 'chat-sessions.json'), sessionData);
const deliveryData = await readRecord(join(output, 'chat-source-deliveries.json')) || [];
for (const delivery of (Array.isArray(deliveryData) ? deliveryData : deliveryData.deliveries || [])) {
  const plan = normalizeSourceDeliveryPlan(delivery);
  if (!plan) throw new Error(`Cannot convert delivery target: ${delivery.id}`);
  const { record } = await store.accept({ sessionId: delivery.sessionId || 'outbound',
    requestId: `converted-delivery:${delivery.id}`, text: delivery.text || '[attachment]',
    options: { deliveryOnly: true }, result: { state: 'completed', payload: { text: delivery.text || '' } },
    plans: buildReplyDeliveries(plan, delivery) });
  await store.mutate(record.key, current => ({ ...current, deliveries: current.deliveries.map(part => ({ ...part,
    state: delivery.state === 'sending' ? 'unknown' : delivery.state,
    externalId: delivery.externalId || '', triggerId: delivery.triggerId || '',
    scheduleId: delivery.scheduleId || '', occurrenceId: delivery.occurrenceId || '',
    lastError: delivery.state === 'sending' ? 'Legacy sender receipt requires manual reconciliation' : delivery.lastError || '',
  })) }));
  await store.archiveFinished(record.key);
  report.deliveries.push({ oldId: delivery.id, newId: record.deliveries[0]?.id, state: delivery.state === 'sending' ? 'unknown' : delivery.state });
}
report.warnings.push('Connector inbox cutover must reconcile old events.jsonl, handled-messages.json and current delivery receipts before restarting the gateway; uncertain ordinary replies must not be replayed.');
await writeDurableJson(join(output, 'conversion-report.json'), report);
await writeDurableJson(join(output, 'requests', 'schema.json'), { version: 1 });
console.log(JSON.stringify(report, null, 2));
