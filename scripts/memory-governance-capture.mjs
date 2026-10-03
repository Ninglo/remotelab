// Trusted, read-only capture. Semantic interpretation belongs to the Harness.
import { createHash } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';

const sha = data => createHash('sha256').update(data).digest('hex');
const sourceLimit = 40 * 1024 * 1024;
const totalLimit = 192 * 1024 * 1024;

export async function captureGovernance(plan) {
  if (plan?.schemaVersion !== 1 || !Array.isArray(plan.projects) || !plan.projects.length
      || !Array.isArray(plan.sources) || plan.sources.length > 256) throw new Error('Invalid capture plan.');
  const records = [], sources = [];
  let bytes = 0;
  const originals = new Set();
  for (const spec of plan.sources) {
    if (!Array.isArray(spec.files) || spec.files.length > 64 || !Array.isArray(spec.projectIds)) throw new Error('Invalid source files.');
    const source = { ...spec, files: [], omitted: 0, selected: 0 };
    delete source.blocks;
    delete source.chatProjects;
    delete source.messageLimit;
    delete source.toolLimit;
    const documents = [];
    for (const path of spec.files) {
      const canonical = await realpath(path);
      const handle = await open(canonical, 'r');
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > sourceLimit || bytes + before.size > totalLimit) throw new Error('Source byte budget exceeded or not a regular file.');
        const data = await handle.readFile();
        const after = await handle.stat();
        const current = await stat(canonical);
        if (before.size !== data.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
            || current.dev !== before.dev || current.ino !== before.ino || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs) throw new Error('Source changed during capture.');
        bytes += data.length;
        source.files.push({ path: canonical, bytes: data.length, sha256: sha(data) });
        documents.push(data.toString('utf8'));
      } finally { await handle.close(); }
    }
    const add = record => {
      if (typeof record.text !== 'string' || !record.text || record.text.length > 40000) { source.omitted++; return; }
      records.push({ sourceId: spec.id, observedAt: spec.cutoff || null, ...record });
      source.selected++;
    };
    if (spec.format === 'feishu-pages') {
      const messages = new Map();
      for (const text of documents) {
        const doc = JSON.parse(text);
        const pages = Array.isArray(doc.messages) ? [doc] : Object.values(doc);
        for (const page of pages) for (const m of page.messages || []) {
          if (m.chat_id !== spec.chatId) throw new Error('Unexpected chat in source.');
          if (messages.has(m.message_id) && JSON.stringify(messages.get(m.message_id).content) !== JSON.stringify(m.content)) throw new Error('Conflicting visible message snapshots.');
          messages.set(m.message_id, m);
        }
      }
      for (const m of messages.values()) {
        const key = `feishu:${m.chat_id}:${m.message_id}`;
        originals.add(key);
        add({ evidenceKey: key, projectIds: spec.projectIds, text: m.content,
          actor: m.sender?.name || m.sender?.id || '身份待核', occurredAt: m.create_time,
          sourceRef: m.message_app_link || key, kind: m.deleted ? 'source-recalled' : m.sender?.sender_type === 'app' ? 'agent-report' : 'group-message' });
      }
    } else if (spec.format === 'markdown-blocks') {
      if (documents.length !== 1 || !Array.isArray(spec.blocks)) throw new Error('Invalid markdown blocks.');
      const lines = documents[0].split('\n');
      for (const block of spec.blocks) {
        if (!Number.isInteger(block.start) || !Number.isInteger(block.end) || block.start < 1 || block.end < block.start || block.end > lines.length) throw new Error('Invalid markdown range.');
        add({ evidenceKey: `ledger:${block.id}`, projectIds: block.projectIds,
          text: lines.slice(block.start - 1, block.end).join('\n'), kind: 'existing-ledger',
          sourceRef: `${spec.files[0]}:${block.start}`, actor: '既有项目主账（派生认识）', occurredAt: spec.cutoff });
      }
    } else if (spec.format === 'session-events') {
      const messageLimit = spec.messageLimit ?? 100, toolLimit = spec.toolLimit ?? 20;
      if (!Number.isInteger(messageLimit) || messageLimit < 0 || messageLimit > 500 || !Number.isInteger(toolLimit) || toolLimit < 0 || toolLimit > 100) throw new Error('Invalid Session limits.');
      for (const text of documents) {
        const doc = JSON.parse(text);
        if (typeof doc.sessionId !== 'string' || !Array.isArray(doc.events)) throw new Error('Invalid Session snapshot.');
        const messages = doc.events.filter(e => e.type === 'message' && ['user','assistant'].includes(e.role));
        const tools = doc.events.filter(e => e.type === 'tool_result');
        source.omitted += Math.max(0, messages.length - messageLimit) + Math.max(0, tools.length - toolLimit);
        for (const e of [...messages.slice(-messageLimit || messages.length), ...tools.slice(-toolLimit || tools.length)]) {
          const sc = e.sourceContext;
          const lineageKey = sc?.chatId && sc?.messageId ? `feishu:${sc.chatId}:${sc.messageId}` : undefined;
          if (lineageKey && originals.has(lineageKey)) { source.reusedOriginals = (source.reusedOriginals || 0) + 1; continue; }
          const groupProjects = (sc?.chatId && spec.chatProjects?.[sc.chatId]) || [];
          const projectIds = [...new Set([...spec.projectIds, ...groupProjects])];
          add({ evidenceKey: `session:${doc.sessionId}:${e.seq}`, lineageKey,
            projectIds, associationStatus: spec.projectIds.length ? 'candidate-from-ledger-session-link' : groupProjects.length ? 'registered-group' : 'unassigned',
            text: e.type === 'tool_result' ? e.output : e.content,
            actor: e.type === 'tool_result' ? '执行回执（不等于验收）' : e.role === 'assistant' ? 'Agent（派生报告）' : 'Session 用户（实名待核）',
            kind: e.type === 'tool_result' ? 'execution-output' : e.role === 'assistant' ? 'agent-report' : 'session-message',
            sourceRef: `session:${doc.sessionId}#seq=${e.seq}`, occurredAt: e.timestamp ? new Date(e.timestamp).toISOString() : null });
        }
      }
    } else if (spec.format === 'jsonl-stream') {
      for (const text of documents) for (const line of text.split('\n').filter(Boolean)) {
        const row = JSON.parse(line), m = row.summary;
        if (row.allowed !== true || !m?.chatId || !m?.messageId) continue;
        const projectIds = spec.chatProjects?.[m.chatId];
        if (!projectIds) { source.omitted++; continue; }
        const key = `feishu:${m.chatId}:${m.messageId}`;
        if (originals.has(key)) { source.reusedOriginals = (source.reusedOriginals || 0) + 1; continue; }
        // Stream snippets are separate representations, not edits of full messages.
        add({ evidenceKey: key + ':stream:' + sha(m.messageText || '').slice(0,12), lineageKey: key,
          projectIds, text: m.messageText, actor: m.sender?.name || '身份待核',
          kind: row.outbound ? 'agent-report' : 'group-message', representation: 'bounded-stream-snippet',
          sourceRef: key, occurredAt: m.createTime || row.receivedAt });
      }
    } else throw new Error('Unsupported source adapter.');
    sources.push(source);
  }
  const corpus = { schemaVersion: 1, stage: 'isolated-test', projects: plan.projects, sources, records,
    capturedAt: new Date().toISOString(), inventory: { ...plan.inventory, capturedSourceBytes: bytes, inputRecords: records.length },
    ...(plan.expectedRevision === undefined ? {} : { expectedRevision: plan.expectedRevision }) };
  const text = JSON.stringify(corpus);
  if (records.length > 20000 || Buffer.byteLength(text) > 32 * 1024 * 1024) throw new Error('Projected corpus budget exceeded; narrow explicit windows, never silently truncate.');
  return corpus;
}
