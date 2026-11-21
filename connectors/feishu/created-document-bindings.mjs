import { randomUUID } from 'node:crypto';
import { readCreatedDocument } from '../../lib/feishu-document-creation.mjs';
import { claimOnce } from '../../lib/durable-records.mjs';
import { withFileLock } from '../../lib/file-lock.mjs';
import { createConnectorSession } from '../../lib/connector-turn-flow.mjs';
import { documentBindingPath, readBindingJson } from './document-bindings.mjs';

export async function ensureDocumentBinding(runtime, summary) {
  const path = documentBindingPath(runtime.config.storageDir, summary.fileToken);
  return withFileLock(`${path}.flock`, () => resolveDocumentBinding(runtime, summary, path));
}

async function resolveDocumentBinding(runtime, summary, path) {
  const existing = await readBindingJson(path);
  // Explicit targets, mention-only bindings and disabled bindings never change
  // ownership mode or Session when a later comment arrives.
  if (existing && (!existing.createdDocument || !existing.enabled
    || existing.sourceRouteId !== runtime.config.sourceRouteId)) return existing;
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
  const owned = ownIds.has(meta.owner_id);
  if (existing) return owned ? existing : null;
  const intentPath = `${path}.session.json`;
  let intent = await readBindingJson(intentPath);
  const mentionOnly = intent ? intent.documentBindingIntake === 'mention' : !owned;
  if (mentionOnly ? !summary.mentionedBot : !owned) return null;
  const created = owned && !mentionOnly ? await readCreatedDocument(runtime.config.appId, summary.fileToken, runtime.config.configDir) : null;
  let session;
  if (!intent && created?.sessionId) {
    const result = await runtime.requestRemoteLab(`/api/sessions/${encodeURIComponent(created.sessionId)}`);
    if (!result.response.ok || !result.json?.session?.id || result.json.session.archived) {
      throw Object.assign(new Error(`Document creator Session unavailable (${result.response.status})`),
        { httpStatus: result.response.status });
    }
    session = result.json.session;
  } else {
    if (!intent) {
      const selection = await runtime.resolveDocumentRuntime?.() || { tool: runtime.config.sessionTool || 'codex' };
      const payload = {
        folder: runtime.config.sessionFolder, ...selection,
        name: created?.title || meta.title || '飞书文档评论', sourceId: 'feishu', sourceName: 'Feishu',
        externalTriggerId: `feishu:created-document:${runtime.config.sourceRouteId}:${summary.fileToken}`,
        conversation: { connector: 'feishu', sourceRouteId: runtime.config.sourceRouteId,
          target: { conversationKind: 'document_comment', fileToken: summary.fileToken,
            fileType: summary.fileType, commentId: summary.commentId } },
      };
      // Persist the original create request across lost ACKs and restarts.
      await claimOnce(intentPath, { ...payload, documentBindingIntake: mentionOnly ? 'mention' : 'owned',
        firstReplyId: summary.replyId || '' });
      intent = await readBindingJson(intentPath);
    }
    const { documentBindingIntake, firstReplyId, ...payload } = intent;
    session = await createConnectorSession(runtime.requestRemoteLab, payload);
  }
  const binding = {
    version: 1, generation: randomUUID(), enabled: true,
    fileToken: summary.fileToken, fileType: summary.fileType,
    documentUrl: created?.documentUrl || meta.url || `https://feishu.cn/docx/${summary.fileToken}`,
    sessionId: session.id, sourceRouteId: runtime.config.sourceRouteId,
    conversation: session.conversation || null, replyMode: 'comment',
    ...(mentionOnly ? { mentionOnly: true } : { createdDocument: true }),
    since: created?.createdAt || '',
    firstCommentId: intent?.conversation?.target?.commentId || summary.commentId,
    firstReplyId: intent?.firstReplyId ?? summary.replyId ?? '',
  };
  await claimOnce(path, binding);
  return readBindingJson(path);
}
