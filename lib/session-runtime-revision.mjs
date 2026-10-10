import { createHash } from 'node:crypto';

export function sessionRuntimeRevision(session) {
  return createHash('sha256').update(JSON.stringify([session.id, session.tool, session.model || '',
    session.effort || '', session.thinking === true, session.feishuRuntimeSelection || null,
    session.runtimeTier || '', session.executionProfile || '', session.conversation || null])).digest('hex');
}
