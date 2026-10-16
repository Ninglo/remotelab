import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { writeDurableJson } from '../../lib/durable-records.mjs';

const exec = promisify(execFile);
const launcher = fileURLToPath(new URL('../../scripts/lark-cli.mjs', import.meta.url));
const tokenPattern = /^[A-Za-z0-9]+$/;
export function artifactToken(url, kind) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !/(^|\.)(feishu\.cn|larksuite\.com)$/.test(parsed.hostname)) return '';
    const match = parsed.pathname.match(new RegExp(`^/${kind}/([A-Za-z0-9]+)$`));
    return match?.[1] || '';
  } catch { return ''; }
}
export function materialError(error) {
  const response = error?.response?.data;
  return { message: String(response?.msg || error?.message || error).slice(0, 1200),
    code: response?.code ?? error?.code ?? null, httpStatus: error?.httpStatus || error?.response?.status || null,
    logId: response?.error?.log_id || error?.logId || null };
}
export function denied(error) {
  return Number(error?.httpStatus) === 403 || [2091005, 121005, 99991672, 1770032].includes(Number(error?.code))
    || /permission|access denied|forbidden|无权限/i.test(error?.message || '');
}
export async function meetingApi(runtime, args) {
  const response = await runtime.appClient.request(args);
  if (response?.code !== 0) throw Object.assign(new Error(response?.msg || 'Invalid Feishu response'),
    { code: response?.code, logId: response?.error?.log_id || response?.log_id });
  return response.data || {};
}

// Only follow the explicit transcript section, never arbitrary linked documents
// or a model-generated summary as a substitute for original speech.
export function transcriptLink(xml) {
  const index = xml.lastIndexOf('文字记录');
  if (index < 0) return '';
  const section = xml.slice(index);
  for (const match of section.matchAll(/href="([^"]+)"/g)) {
    if (artifactToken(match[1], 'docx')) return match[1];
  }
  return '';
}
export function createMeetingMaterialReader(runtime, options = {}) {
  const api = options.api || (args => meetingApi(runtime, args));
  const cli = options.cli || (async (args, identity = 'bot') => {
    let stdout;
    try {
      ({ stdout } = await exec(process.execPath, [launcher, '--profile', runtime.config.sourceRouteId || 'default', ...args,
        '--as', identity, '--format', 'json'], { timeout: 60000, maxBuffer: 24 * 1024 * 1024,
        env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } }));
    } catch (error) {
      if (!error.stdout) throw new Error(`Feishu material CLI failed: ${error.code || 'transport'}`);
      stdout = error.stdout;
    }
    const result = JSON.parse(stdout);
    if (!result.ok) throw Object.assign(new Error(result.error?.message || 'Feishu material read failed'),
      { code: result.error?.code, logId: result.error?.log_id });
    return result.data;
  });
  const exportTranscript = options.exportTranscript || (async minuteToken => {
    const result = await runtime.appClient.minutes.v1.minuteTranscript.get({ path: { minute_token: minuteToken },
      params: { need_speaker: true, need_timestamp: true, file_format: 'txt' } });
    let length = 0; const chunks = [];
    for await (const chunk of result.getReadableStream()) {
      length += chunk.length;
      if (length > 16 * 1024 * 1024) throw new Error('Transcript exceeds 16 MiB limit');
      chunks.push(Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString('utf8');
    // Binary SDK methods can return an HTTP-success JSON error body.
    if (text.trim().startsWith('{')) {
      try {
        const json = JSON.parse(text);
        if (json.code) throw Object.assign(new Error(json.msg), { code: json.code, logId: json.error?.log_id });
      } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    }
    return text;
  });
  return async function readMaterials(state, hints = {}, policy = {}) {
    const dir = resolve(runtime.config.storageDir, 'meeting-ingest', 'materials', state.meetingId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const evidence = { meetingId: state.meetingId, readAt: new Date().toISOString(), identity: 'bot', errors: [],
      sourceRefs: hints.sourceRefs || [], minuteUrl: hints.minuteUrl || '', noteUrl: hints.noteUrl || '', transcriptUrl: '' };
    const attempt = async (name, operation) => {
      try { return await operation(); }
      catch (error) { evidence.errors.push({ stage: name, ...materialError(error) }); return null; }
    };
    const recording = await attempt('recording', () => api({ method: 'GET',
      url: `/open-apis/vc/v1/meetings/${state.meetingId}/recording` }));
    if (artifactToken(recording?.recording?.url, 'minutes')) evidence.minuteUrl ||= recording.recording.url;
    const artifacts = await attempt('artifacts', () => api({ method: 'GET',
      url: `/open-apis/vc/v1/meetings/${state.meetingId}`, params: { query_mode: 1 } }));
    const related = artifacts?.related_artifacts || {};
    // Tokens returned by the provider are identifiers, never arbitrary paths.
    const base = policy.documentBaseUrl || (hints.noteUrl ? new URL(hints.noteUrl).origin : '');
    const docUrl = token => tokenPattern.test(token || '') && artifactToken(`${base}/docx/${token}`, 'docx')
      ? `${base}/docx/${token}` : '';
    evidence.noteUrl ||= docUrl(related.note_doc_token);
    let transcript = '';
    const minuteToken = artifactToken(evidence.minuteUrl, 'minutes');
    if (minuteToken) transcript = await attempt('minutes_transcript', () => exportTranscript(minuteToken)) || '';
    if (transcript.trim()) evidence.transcriptUrl = evidence.minuteUrl;
    let noteArtifacts;
    // Some tenants expose note_id in meeting metadata while hiding the
    // query_mode=1 artifact fields. The Note API is user-only: use an existing
    // authorized identity only when this instance explicitly opts in. Content
    // reads and all group writes remain Bot operations.
    if (!transcript.trim() && !evidence.noteUrl && !related.verbatim_doc_token && policy.userNoteLookup === true) {
      const metadata = await attempt('meeting_note_id', () => api({ method: 'GET',
        url: `/open-apis/vc/v1/meetings/${state.meetingId}`, params: { query_mode: 0 } }));
      const noteId = metadata?.meeting?.note_id;
      if (/^\d{10,30}$/.test(noteId || '')) {
        evidence.noteLookup = { noteId, identity: 'user', profile: runtime.config.sourceRouteId || 'default' };
        const data = await attempt('note_metadata', async () => {
          const data = await cli(['note', '+detail', '--note-id', noteId], 'user');
          if (data?.note?.note_id !== noteId) throw new Error('Note metadata identity mismatch');
          return data;
        });
        noteArtifacts = data?.note;
        evidence.noteLookup.displayType = noteArtifacts?.note_display_type || '';
        evidence.noteUrl ||= docUrl(noteArtifacts?.note_doc_token);
      }
    }
    let note = '';
    if (artifactToken(evidence.noteUrl, 'docx')) {
      const data = await attempt('note_document', () => cli(['docs', '+fetch', '--doc', evidence.noteUrl]));
      note = data?.document?.content || '';
      if (note) await writeFile(join(dir, 'note.xml'), note, { mode: 0o600 });
    }
    if (!transcript.trim()) {
      const url = noteArtifacts?.note_display_type === 'unified' ? ''
        : docUrl(related.verbatim_doc_token) || docUrl(noteArtifacts?.verbatim_doc_token) || transcriptLink(note);
      if (url) {
        const data = await attempt('verbatim_document', () => cli(['docs', '+fetch', '--doc', url]));
        const content = data?.document?.content || '';
        // Unified notes are not a standalone transcript. Keep the missing
        // capability explicit rather than analysing the summary tab.
        if (content && !content.includes('<vc-transcribe-tab') && /\d{2}:\d{2}:\d{2}/.test(content)) {
          transcript = content; evidence.transcriptUrl = url;
        }
      }
    }
    if (transcript.trim()) {
      const path = join(dir, 'transcript.txt');
      await writeFile(path, transcript, { mode: 0o600 });
      evidence.transcriptPath = path;
      evidence.characters = transcript.length;
      evidence.sha256 = createHash('sha256').update(transcript).digest('hex');
      evidence.status = 'readable_transcript';
    } else evidence.status = evidence.errors.some(denied) ? 'permission_denied' : 'waiting_material';
    await writeDurableJson(join(dir, 'source.json'), evidence);
    return { ...evidence, sourcePath: join(dir, 'source.json'), minuteToken };
  };
}
