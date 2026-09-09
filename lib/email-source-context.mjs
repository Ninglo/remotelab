import { buildEmailSourceRouteId, parseReferencesArray } from './agent-mail-source-delivery.mjs';

// Both HTTP and embedded workers use the same inbound snapshot. Outbound
// addresses/credentials continue to belong to sourceDelivery, independently.
export function buildEmailSourceContext(item, rootDir, extractedAttachmentCount) {
  const message = item?.message || {};
  const references = parseReferencesArray(message.references);
  const expectedAttachmentCount = Number(item?.content?.attachmentCount) || 0;
  const partial = extractedAttachmentCount < expectedAttachmentCount;
  return {
    connector: 'email', sourceRouteId: buildEmailSourceRouteId(rootDir),
    messageId: message.messageId || '',
    threadId: references[0] || message.inReplyTo || message.messageId || '',
    sender: { address: message.fromAddress || '' },
    subject: message.subject || '', date: message.date || '',
    inReplyTo: message.inReplyTo || '', references,
    ingestion: {
      status: partial ? 'partial' : 'complete', expectedAttachmentCount, extractedAttachmentCount,
      ...(partial && item?.storage?.rawPath ? { rawPath: item.storage.rawPath } : {}),
    },
  };
}
