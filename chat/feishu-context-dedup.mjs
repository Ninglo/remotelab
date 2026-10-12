import { pageSourceContext, hydrateSourceContext } from './source-context-pages.mjs';
import { createHash } from 'node:crypto';
import { loadHistory } from './history.mjs';
import { getRun, getRunManifest, runDir } from './runs.mjs';
import { requests } from './requests.mjs';
import { readNativeInputReceipt } from './native-input-transport.mjs';

const trim = value => typeof value === 'string' ? value.trim() : '';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identityFields = ['codexThreadId', 'claudeSessionId', 'antigravityConversationId'];
export function feishuResumeIdentity(value = {}) {
  const field = identityFields.find(key => trim(value[key]));
  return field ? { field, id: value[field] } : null;
}
const key = (source, entry, chatId = source.chatId) => entry.messageId && chatId
  ? JSON.stringify([source.sourceRouteId || 'default', chatId, entry.messageId]) : '';
const version = entry => String(entry.messageRevision || entry.updateTime || entry.createTime || '');
const signature = entry => digest([entry.text, entry.sender, entry.authorRef || null, version(entry)]);

// Derived from canonical Requests, Runs and delivery receipts, never a second
// read-state store. Missing evidence costs repetition, never message loss.
async function project(sessionId, source, { identity, requestId = '' } = {}, deps = {}) {
  if (source?.connector !== 'feishu' || !sessionId) return { sourceContext: source, receipt: null };
  const history = deps.history || loadHistory;
  const readRun = deps.run || getRun;
  const readManifest = deps.manifest || getRunManifest;
  const readRequest = deps.request || ((id, request) => requests.byRequest(id, request));
  const readAccepted = deps.accepted || ((run, request) => readNativeInputReceipt(runDir(run), request));
  const groups = [
    ['conversationContext', source.chatId, Infinity],
    ['groupAnnouncement', source.chatId, 1],
    ['linkedProjectContext', source.linkedProjectContext?.sourceChatId, 20],
  ];
  const entries = groups.flatMap(([name, chat, limit]) => (source[name]?.messages || []).slice(0, limit)
    .map(entry => ({ entry, key: key(source, entry, chat) })));
  const wanted = new Set(entries.map(item => item.key).filter(Boolean));
  const wantedIds = new Set(entries.map(item => item.entry.messageId).filter(Boolean));
  const seen = new Map(), own = new Set();
  const runs = new Map();
  const run = id => { if (!runs.has(id)) runs.set(id, readRun(id)); return runs.get(id); };
  const sameThread = value => identity && value?.sessionId === sessionId && value[identity.field] === identity.id;
  let scanned = 0;
  if (identity && wanted.size) {
    // Complete source replay needs the canonical prior delivery evidence, not
    // only the last 40 inputs. No semantic history or second memory is created.
    const events = await history(sessionId, { fromSeq: 1, includeBodies: false });
    const candidates = new Map();
    for (const event of [...events].reverse()) {
      if (event.type === 'source_delivery' && event.kind === 'content' && event.state === 'delivered'
          && event.runId && event.providerMessageId && wantedIds.has(event.externalId) && sameThread(await run(event.runId))) {
        own.add(event.externalId);
      }
      if (event.type === 'message' && event.role === 'user' && event.requestId !== requestId
          && event.sourceContext?.connector === 'feishu') candidates.set(event.requestId, event);
    }
    for (const event of candidates.values()) {
      const record = await readRequest(sessionId, event.requestId);
      if (!record || record.options?.deliveryOnly) continue;
      const execution = await run(record.nativeDispatchRunId || record.runId);
      if (!sameThread(execution)) continue;
      const manifest = record.nativeDispatchRunId ? null : await readManifest(record.runId);
      const receipt = record.nativeDispatchRunId ? record.nativeContextDelivery : manifest?.feishuContextDelivery;
      if (!receipt || receipt.version !== 1) continue;
      const accepted = record.nativeReceipt?.accepted === true
        || (await readAccepted(execution.id, record.requestId))?.state === 'accepted';
      if (!accepted) continue;
      scanned++;
      for (const item of receipt.entries || []) {
        if (!wanted.has(item.key)) continue;
        const versions = seen.get(item.key) || [];
        versions.push(item); seen.set(item.key, versions);
      }
    }
  }
  const selected = new Set();
  const receipt = { version: 1, entries: [], stats: { considered: entries.length, removed: 0, retained: 0, acceptedInputs: scanned } };
  const result = { ...source };
  for (const [name, chat, limit] of groups) {
    if (!source[name]?.messages) continue;
    const messages = source[name].messages.slice(0, limit).filter(entry => {
      const id = key(source, entry, chat), hash = signature(entry);
      const repeated = id && (seen.get(id) || []).some(item => item.hash === hash
        || item.direct && item.revision && item.revision === version(entry));
      // Receipt ownership alone is insufficient for edited messages or a fresh
      // provider thread. Do not blanket-filter other bots or same-name senders.
      const generatedHere = identity && chat === source.chatId && entry.edited === false
        && (entry.senderType || entry.authorRef?.senderType) === 'app' && own.has(entry.messageId);
      const packetKey = id && JSON.stringify([id, hash]);
      if (repeated || generatedHere || packetKey && selected.has(packetKey)) {
        // Carry proven announcement knowledge through later accepted inputs.
        if (name === 'groupAnnouncement' && repeated) receipt.entries.push({ key: id, hash });
        receipt.stats.removed++; return false;
      }
      if (id) { receipt.entries.push({ key: id, hash }); selected.add(packetKey); }
      receipt.stats.retained++;
      return true;
    });
    result[name] = { ...source[name], messages };
  }
  const directKey = key(source, source);
  if (directKey && version(source)) receipt.entries.push({ key: directKey, direct: true, revision: version(source) });
  const paged = await (deps.page || pageSourceContext)(sessionId, result);
  // Only inline whole messages have been delivered. A file pointer is not a
  // read receipt; never mark overflow as seen merely because it was archived.
  const inline = new Set((paged.conversationContext?.messages || []).map(entry => key(source, entry)));
  const conversationKeys = new Set((result.conversationContext?.messages || []).map(entry => key(source, entry)));
  receipt.entries = receipt.entries.filter(item => item.direct || !conversationKeys.has(item.key) || inline.has(item.key));
  return { sourceContext: paged, receipt };
}

export async function projectFeishuContext(sessionId, source, options, deps) {
  try {
    source = await hydrateSourceContext(sessionId, source);
    return await project(sessionId, source, options, deps);
  }
  catch (error) {
    console.warn(`[feishu-context] retaining source after unavailable receipt evidence: ${error.message}`);
    return { sourceContext: source?.conversationContext?.frozenArchive
      ? { ...source, conversationContext: { ...source.conversationContext, error: error.message, truncated: true } } : source, receipt: null };
  }
}
