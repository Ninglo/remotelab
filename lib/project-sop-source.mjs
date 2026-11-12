import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

// The foreground Harness supplies its interpretation of the human request.
// This is a routing contract, not another model or a keyword classifier.
export function assessProjectRequest(packet, existing = null) {
  if (!nonempty(packet.sourceRequestId) || !nonempty(packet.evidence)) throw Error('Request source and human evidence required');
  if (!['project', 'followup', 'atomic', 'discussion', 'status', 'framework'].includes(packet.kind)) throw Error('Unknown request kind');
  const context = existing ? { project: existing.state.id, enabled: existing.binding.enabled, status: existing.state.status } : null;
  if (['discussion', 'status', 'framework'].includes(packet.kind)) return { route: 'ordinary', context, activate: false };
  if (packet.kind === 'atomic') return { route: 'atomic', context, activate: false };
  if (packet.kind === 'followup') {
    if (!existing || packet.sameProject !== true) return { route: 'needs_context', reason: 'Resolve the original concrete project', activate: false };
    return { route: 'existing', skill: 'real-device-project', context, activate: false,
      action: !existing.binding.enabled ? 'keep_disabled' : existing.state.status === 'paused' ? 'keep_paused'
        : existing.state.status === 'completed' ? 'keep_completed' : 'read_sop' };
  }
  if (packet.domain !== 'real_device') return { route: ['software', 'simulation'].includes(packet.domain) ? 'ordinary' : 'needs_context',
    reason: 'Establish the physical experiment or device task, not only a project label', activate: false };
  if (!nonempty(packet.object) || !nonempty(packet.goal) || packet.needsTracking !== true) {
    return { route: 'needs_context', reason: 'Concrete real-device objective and persistent work must be established', activate: false };
  }
  if (existing) return { route: packet.sameProject === true ? 'existing' : 'needs_context', context,
    skill: packet.sameProject === true ? 'real-device-project' : null, activate: false,
    reason: packet.sameProject === true ? 'Reuse the existing SOP' : 'Do not replace this conversation’s bound project' };
  return { route: 'bind_sop', skill: 'real-device-project', activate: false, object: packet.object, goal: packet.goal };
}

export function validateSopDocument(document) {
  if (document?.kind === 'local' && isAbsolute(document.path || '')) return document;
  if (document?.kind === 'feishu' && nonempty(document.profile)) {
    const url = new URL(document.url);
    if (url.protocol === 'https:' && /\/(docx|wiki)\/[a-zA-Z0-9]+\/?$/.test(url.pathname)) return document;
  }
  throw Error('SOP document needs an absolute local path or Feishu document URL and Bot profile');
}

export async function readSopDocument(document, { run = execute } = {}) {
  validateSopDocument(document);
  let content, revision = null, documentId = null;
  if (document.kind === 'local') content = await readFile(document.path, 'utf8');
  else {
    const result = await run('lark-cli', ['--profile', document.profile, 'docs', '+fetch', '--doc', document.url,
      '--doc-format', 'markdown', '--detail', 'simple', '--as', 'bot', '--format', 'json'],
    { timeout: 25000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } });
    const response = JSON.parse(result.stdout);
    if (response.ok !== true || !response.data?.document) throw Error('SOP document fetch failed');
    ({ content, revision_id: revision, document_id: documentId } = response.data.document);
  }
  if (!nonempty(content)) throw Error('SOP document is empty');
  return { source: document, content, revision, documentId,
    sha256: createHash('sha256').update(content).digest('hex'), readAt: new Date().toISOString(), writeback: 'deferred' };
}
