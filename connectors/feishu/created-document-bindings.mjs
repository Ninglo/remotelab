import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readCreatedDocument } from '../../lib/feishu-document-creation.mjs';
import { claimOnce } from '../../lib/durable-records.mjs';
import { createConnectorSession } from '../../lib/connector-turn-flow.mjs';
import { bindingKey, bindingsDirectory, readBindingJson } from './document-bindings.mjs';

export async function ensureCreatedDocumentBinding(runtime, summary) {
  const path = join(bindingsDirectory(runtime.config.storageDir), `${bindingKey(summary.fileToken)}.binding.json`);
  const existing = await readBindingJson(path);
  // An explicit binding (including an unbind tombstone) always wins.
  if (existing && (!existing.createdDocument || !existing.enabled
    || existing.sourceRouteId !== runtime.config.sourceRouteId)) {
    return existing.sourceRouteId === runtime.config.sourceRouteId ? existing : null;
  }
  const ownIds = new Set(Object.values(runtime.botIdentity || {}).filter(Boolean));
  if (!ownIds.size) throw new Error('Bot identity unavailable for document intake');
  if (Object.values(summary.sender || {}).some(id => ownIds.has(id))) return null;
  const response = await runtime.appClient.drive.v1.meta.batchQuery({
    params: { user_id_type: 'open_id' },
    data: { request_docs: [{ doc_token: summary.fileToken, doc_type: summary.fileType }], with_url: true },
  });
  const meta = response.data?.metas?.find(item => item.doc_token === summary.fileToken);
  if ((response.code && response.code !== 0) || !meta) {
    throw Object.assign(new Error(`Document ownership read failed: ${response.msg || 'metadata unavailable'}`),
      { code: response.code || response.data?.failed_list?.[0]?.code });
  }
  if (!ownIds.has(meta.owner_id)) return null;
  if (existing) return existing;
  const created = await readCreatedDocument(runtime.config.appId, summary.fileToken, runtime.config.configDir)
    || { fileToken: summary.fileToken, fileType: summary.fileType, title: meta.title, documentUrl: meta.url };
  let session;
  if (created.sessionId) {
    const result = await runtime.requestRemoteLab(`/api/sessions/${encodeURIComponent(created.sessionId)}`);
    if (!result.response.ok || !result.json?.session?.id) {
      throw Object.assign(new Error(`Document creator Session unavailable (${result.response.status})`),
        { httpStatus: result.response.status });
    }
    session = result.json.session;
  } else {
    const selection = await runtime.resolveDocumentRuntime?.() || { tool: runtime.config.sessionTool || 'codex' };
    const payload = {
      folder: runtime.config.sessionFolder, ...selection,
      name: created.title || '飞书文档评论', sourceId: 'feishu', sourceName: 'Feishu',
      externalTriggerId: `feishu:created-document:${runtime.config.sourceRouteId}:${summary.fileToken}`,
      conversation: { connector: 'feishu', sourceRouteId: runtime.config.sourceRouteId,
        target: { conversationKind: 'document_comment', fileToken: summary.fileToken,
          fileType: summary.fileType, commentId: summary.commentId } },
    };
    // Reuse the first comment address even if creation succeeds but its ACK or
    // the binding write is lost, and a later comment arrives in another thread.
    const intentPath = `${path}.session.json`;
    await claimOnce(intentPath, payload);
    session = await createConnectorSession(runtime.requestRemoteLab, await readBindingJson(intentPath));
  }
  const binding = {
    version: 1, generation: randomUUID(), enabled: true,
    fileToken: created.fileToken, fileType: created.fileType, documentUrl: created.documentUrl,
    sessionId: session.id, sourceRouteId: runtime.config.sourceRouteId,
    conversation: session.conversation || null, replyMode: 'comment',
    createdDocument: true, since: created.createdAt || '',
    firstCommentId: summary.commentId, firstReplyId: summary.replyId || '',
  };
  await claimOnce(path, binding);
  return readBindingJson(path);
}
