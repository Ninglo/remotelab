import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { CONFIG_DIR } from './config.mjs';
import { withFileLock } from './file-lock.mjs';
import { readJson, writeJsonAtomic, writeTextAtomic } from '../chat/fs-utils.mjs';
import { assessProjectRequest, validateSopDocument, readSopDocument } from './project-sop-source.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const text = (value, label) => { if (typeof value !== 'string' || !value.trim()) throw Error(`${label} required`); return value.trim(); };
const id = value => { if (!/^[a-zA-Z0-9_-]{1,100}$/.test(value || '')) throw Error('Invalid project/session/node ID'); return value; };
const root = dir => join(dir, 'project-mainlines');
const registry = (session, dir) => join(root(dir), 'bindings', id(session) + '.json');
const location = (project, dir) => join(root(dir), id(project), 'state.json');
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
const statuses = new Set(['pending', 'running', 'done', 'waiting', 'blocked', 'cancelled']);

export function validateSop(sop) {
  text(sop.goal, 'goal'); text(sop.scope, 'scope'); text(sop.sourceRequestId, 'sourceRequestId');
  if (!Array.isArray(sop.nodes) || !sop.nodes.length || sop.nodes.length > 40) throw Error('SOP needs 1–40 nodes');
  if (sop.document) validateSopDocument(sop.document);
  const ids = new Set();
  for (const n of sop.nodes) {
    id(n.id); if (ids.has(n.id)) throw Error('Duplicate node'); ids.add(n.id);
    text(n.title, 'title'); text(n.method, 'method');
    if (sop.document) text(n.source, 'SOP node source section');
    if (!Array.isArray(n.acceptance) || !n.acceptance.length || n.acceptance.some(x => typeof x !== 'string' || !x.trim())) throw Error('Node acceptance required');
    if (!Array.isArray(n.dependsOn)) throw Error('dependsOn array required');
  }
  const visit = (node, path = new Set()) => {
    if (path.has(node.id)) throw Error('Cyclic SOP');
    for (const dep of node.dependsOn) {
      if (!ids.has(dep)) throw Error('Unknown dependency');
      visit(sop.nodes.find(n => n.id === dep), new Set([...path, node.id]));
    }
  };
  sop.nodes.forEach(n => visit(n));
  return sop;
}

export function renderMainline(s) {
  return [`# ${s.title}`, '', `主目标：${s.sop.goal}`, `范围：${s.sop.scope}`, `SOP 版本：${s.sopVersion}；进度版本：${s.revision}；状态：${s.status}`,
    ...(s.sop.document ? [`SOP 原文：${s.sop.document.path || s.sop.document.url}`, 'SOP 写回：待接入；下列进度为执行记录，不代表原文已更新。'] : []), '',
    ...s.sop.nodes.flatMap(n => {
      const p = s.progress[n.id];
      return [`## ${n.id} · ${n.title}`, `状态：${p.status}；依赖：${n.dependsOn.join(', ') || '无'}`, `方法：${n.method}`,
        ...n.acceptance.map((a, i) => `- [${p.checks?.some(c => c.index === i && c.passed) ? 'x' : ' '}] ${a}`),
        `进展：${p.note || '尚未执行'}`, ...(p.checks || []).flatMap(c => c.evidence.map(e => `证据：${e.path} (sha256:${e.sha256})`)), ''];
    }), `下一步：${s.checkpoint?.nextAction || '核对当前 SOP 与首个未完成节点'}`,
    ...(s.checkpoint?.wait ? [`等待：${JSON.stringify(s.checkpoint.wait)}`] : [])].join('\n');
}

async function persist(s, dir) {
  // JSON is canonical. A lost Markdown projection is rebuilt by show/update.
  await writeJsonAtomic(location(s.id, dir), s, { mode: 0o600 });
  await writeTextAtomic(join(root(dir), s.id, 'PROJECT.md'), renderMainline(s) + '\n');
}
export async function readMainline(sessionId, dir = CONFIG_DIR) {
  const binding = await readJson(registry(sessionId, dir));
  if (!binding) return null;
  const state = await readJson(location(binding.projectId, dir));
  if (!state) throw Error('Bound project state missing');
  return { binding, state, path: location(binding.projectId, dir), document: join(root(dir), binding.projectId, 'PROJECT.md') };
}

export async function initMainline(packet, dir = CONFIG_DIR) {
  id(packet.id); id(packet.sessionId); validateSop(packet.sop); text(packet.title, 'title');
  if (packet.sop.document && (assessProjectRequest(packet.request || {}).route !== 'bind_sop'
    || packet.request.sourceRequestId !== packet.sop.sourceRequestId || packet.request.goal !== packet.sop.goal)) throw Error('SOP binding requires a matching real-device project request');
  const source = packet.sop.document ? await readSopDocument(packet.sop.document) : null;
  if (packet.enabled === true) text(packet.enableSourceRequestId, 'explicit experiment enable source');
  await withFileLock(registry(packet.sessionId, dir) + '.lock', () => withFileLock(location(packet.id, dir) + '.lock', async () => {
    const binding = await readJson(registry(packet.sessionId, dir));
    if (binding || await readJson(location(packet.id, dir))) throw Error('Already registered; use existing project');
    const state = { id: packet.id, title: packet.title, projectId: text(packet.projectId, 'registered projectId'),
      ownerSessionId: packet.sessionId, sop: packet.sop, sopSource: source ? { sha256: source.sha256, revision: source.revision, documentId: source.documentId } : null, sopVersion: 1, revision: 1, status: 'active',
      progress: Object.fromEntries(packet.sop.nodes.map(n => [n.id, { status: 'pending', checks: [], note: '' }])),
      turns: { [packet.sessionId]: { inputToken: randomUUID(), readRevision: 0, unchangedStops: 0 } },
      history: [{ action: 'init', at: new Date().toISOString(), sourceRequestId: packet.sop.sourceRequestId, request: packet.request }] };
    await persist(state, dir);
    await writeJsonAtomic(registry(packet.sessionId, dir), { projectId: packet.id, enabled: packet.enabled === true, sourceRequestId: packet.enableSourceRequestId || packet.sop.sourceRequestId }, { mode: 0o600 });
  }));
  return readMainline(packet.sessionId, dir);
}

async function mutate(session, operation, dir) {
  const found = await readMainline(session, dir);
  if (!found) throw Error('Session has no project mainline');
  return withFileLock(found.path + '.lock', async () => {
    const s = await readJson(found.path);
    const result = await operation(s);
    await persist(s, dir);
    return result;
  });
}

export async function checkpointMainline(session, packet, dir = CONFIG_DIR) {
  const bound = await readMainline(session, dir);
  const source = bound?.state.sop.document && !['paused', 'blocked'].includes(packet.decision)
    ? await readSopDocument(bound.state.sop.document) : null;
  await mutate(session, async s => {
    if (packet.expectedRevision !== s.revision) throw Error('Stale revision; read current state first');
    const turn = s.turns[session];
    if (!turn || packet.inputToken !== turn.inputToken) throw Error('Read current inputToken before checkpoint');
    text(packet.sourceRequestId, 'sourceRequestId'); text(packet.summary, 'summary');
    if (s.sop.document && source && source.sha256 !== s.sopSource?.sha256) throw Error('SOP changed; read and reconcile its nodes with revise before advancing');
    if (!['continue', 'wait', 'complete', 'paused', 'blocked'].includes(packet.decision)) throw Error('Invalid decision');
    for (const patch of packet.nodes || []) {
      const n = s.sop.nodes.find(n => n.id === patch.id); if (!n) throw Error('Unknown node');
      if (!statuses.has(patch.status)) throw Error('Invalid node status');
      if (['running', 'done'].includes(patch.status) && n.dependsOn.some(d => s.progress[d].status !== 'done')) throw Error('Dependency incomplete');
      const previous = s.progress[n.id];
      if (previous.status === 'done' && patch.status !== 'done') text(patch.reason, 'reopen reason');
      const checks = patch.checks || previous.checks;
      if (patch.status === 'done') {
        for (let index = 0; index < n.acceptance.length; index++) {
          const check = checks.find(c => c.index === index && c.passed === true);
          if (!check || !Array.isArray(check.evidence) || !check.evidence.length) throw Error('All acceptance criteria need evidence');
          for (const e of check.evidence) {
            if (!e.path?.startsWith('/') || !/^[a-f0-9]{64}$/.test(e.sha256 || '')) throw Error('Evidence needs absolute path and sha256');
            const data = await readFile(e.path); if (!data.length || hash(data) !== e.sha256) throw Error('Evidence missing, empty or changed');
          }
        }
      }
      s.progress[n.id] = { ...previous, status: patch.status, note: text(patch.note, 'node note'), checks };
    }
    if (packet.decision === 'complete' && s.sop.nodes.some(n => s.progress[n.id].status !== 'done')) throw Error('Project incomplete');
    if (packet.decision === 'continue') text(packet.nextAction, 'nextAction');
    if (['wait', 'blocked'].includes(packet.decision)) {
      const w = packet.wait;
      if (!w || !['human', 'external', 'dependency'].includes(w.kind)) throw Error('Typed wait required');
      ['owner', 'reason', 'resumeWhen', 'wakeRef'].forEach(k => text(w[k], `wait.${k}`));
    }
    if (packet.decision === 'paused') text(packet.pauseReason, 'pauseReason');
    if (s.status === 'paused' && packet.decision !== 'paused') text(packet.resumeSourceRequestId, 'explicit resume source');
    s.revision++;
    s.status = ({ complete: 'completed', paused: 'paused', wait: 'waiting', blocked: 'blocked', continue: 'active' })[packet.decision];
    s.checkpoint = { ...packet, revision: s.revision, at: new Date().toISOString() };
    turn.checkpointRevision = s.revision;
    turn.readRevision = 0;
    s.history.push({ action: 'checkpoint', revision: s.revision, decision: packet.decision, summary: packet.summary,
      sourceRequestId: packet.sourceRequestId, at: s.checkpoint.at, nodes: structuredClone(s.progress) });
  }, dir);
  // The tool result is the required readback, not just an acknowledgement.
  return showMainline(session, dir);
}

export async function showMainline(session, dir = CONFIG_DIR) {
  const found = await readMainline(session, dir); if (!found) return null;
  let sopDocument = null;
  if (found.state.sop.document) {
    try {
      sopDocument = await readSopDocument(found.state.sop.document);
      sopDocument.changed = sopDocument.sha256 !== found.state.sopSource?.sha256;
    } catch (error) { sopDocument = { source: found.state.sop.document, error: error.message, writeback: 'deferred' }; }
  }
  await mutate(session, s => {
    if (s.revision !== found.state.revision) throw Error('State changed during SOP read; read again');
    const readable = !sopDocument || (!sopDocument.error && !sopDocument.changed);
    if (s.turns[session]) s.turns[session].readRevision = readable || ['paused', 'blocked'].includes(s.checkpoint?.decision) ? s.revision : 0;
  }, dir);
  const result = await readMainline(session, dir);
  return { ...result, sopDocument, readback: renderMainline(result.state), inputToken: result.state.turns[session]?.inputToken };
}

export async function setMainlineBinding(session, packet, dir = CONFIG_DIR) {
  if (typeof packet.enabled !== 'boolean') throw Error('enabled must be boolean');
  text(packet.sourceRequestId, 'binding sourceRequestId'); text(packet.reason, 'binding reason');
  await withFileLock(registry(session, dir) + '.lock', async () => {
    const binding = await readJson(registry(session, dir));
    if (!binding) throw Error('No project binding');
    await writeJsonAtomic(registry(session, dir), { ...binding, enabled: packet.enabled,
      sourceRequestId: packet.sourceRequestId, reason: packet.reason, updatedAt: new Date().toISOString() }, { mode: 0o600 });
  });
  return readMainline(session, dir);
}

export async function reviseMainline(session, packet, dir = CONFIG_DIR) {
  validateSop(packet.sop);
  const source = packet.sop.document ? await readSopDocument(packet.sop.document) : null;
  await mutate(session, s => {
    if (packet.expectedRevision !== s.revision) throw Error('Stale revision');
    text(packet.reason, 'revision reason');
    s.history.push({ action: 'revise', at: new Date().toISOString(), reason: packet.reason, sourceRequestId: packet.sop.sourceRequestId,
      previousSop: s.sop, previousSource: s.sopSource, previousProgress: s.progress });
    s.progress = Object.fromEntries(packet.sop.nodes.map(n => {
      const before = s.sop.nodes.find(x => x.id === n.id);
      const unchanged = before && JSON.stringify(before) === JSON.stringify(n);
      return [n.id, unchanged ? s.progress[n.id] : { status: 'pending', checks: [], note: 'SOP 更新后待验收' }];
    }));
    // A changed upstream contract invalidates already accepted dependants too.
    let changed;
    do {
      changed = false;
      for (const n of packet.sop.nodes) if (s.progress[n.id].status === 'done' && n.dependsOn.some(d => s.progress[d].status !== 'done')) {
        s.progress[n.id] = { status: 'pending', checks: [], note: '上游 SOP 改变，重新验收' }; changed = true;
      }
    } while (changed);
    s.sop = packet.sop; s.sopSource = source ? { sha256: source.sha256, revision: source.revision, documentId: source.documentId } : null; s.sopVersion++; s.revision++;
    if (s.status === 'completed') s.status = 'active';
    s.checkpoint = null;
  }, dir);
  return showMainline(session, dir);
}

function prompt(s, session) {
  return 'Project mainline is enabled for this Session. Keep the original goal and SOP; questions and corrections do not replace it. '
    + 'Use the real-device-project Skill. Before a final response, run `remotelab project-track checkpoint --file <JSON>`; '
    + 'For a bound SOP, run project-track show to read its original content and derived todo. SOP writeback is deferred; local progress does not update that document. '
    + 'The checkpoint result reads back the SOP and saved todo. Completion needs every criterion and referenced evidence. '
    + 'Continue executable authorized work; for a true wait record its owner, resume condition and existing wake mechanism. '
    + 'Paused work must stay paused until an explicit resume. Do not invent progress or widen authorization.\n'
    + JSON.stringify({ project: s.id, revision: s.revision, inputToken: s.turns[session]?.inputToken, status: s.status,
      goal: s.sop.goal, sopDocument: s.sop.document, sopWriteback: s.sop.document ? 'deferred' : undefined, nextAction: s.checkpoint?.nextAction, wait: s.checkpoint?.wait,
      nodes: s.sop.nodes.map(n => ({ id: n.id, title: n.title, acceptance: n.acceptance, ...s.progress[n.id] })) });
}

export async function mainlineHook(session, input, dir = CONFIG_DIR) {
  const bound = await readMainline(session, dir);
  if (!bound?.binding.enabled) return {};
  let output = {};
  await mutate(session, s => {
    const event = input.hook_event_name;
    if (event === 'UserPromptSubmit') {
      s.turns[session] = { inputToken: randomUUID(), nativeTurnId: input.turn_id, readRevision: 0, unchangedStops: 0 };
      output = { hookSpecificOutput: { hookEventName: event, additionalContext: prompt(s, session) } };
    } else if (event === 'SessionStart') {
      output = { hookSpecificOutput: { hookEventName: event, additionalContext: prompt(s, session) } };
    } else if (event === 'Interrupt') {
      s.status = 'paused'; s.revision++;
      s.history.push({ action: 'interrupt', at: new Date().toISOString(), nativeTurnId: input.turn_id });
    } else if (event === 'Stop') {
      const t = s.turns[session] || (s.turns[session] = { inputToken: randomUUID(), readRevision: 0, unchangedStops: 0 });
      const fresh = t.checkpointRevision === s.revision && t.readRevision === s.revision && s.checkpoint?.inputToken === t.inputToken;
      const allowed = fresh && s.checkpoint.decision !== 'continue';
      if (allowed) { t.verdict = { decision: 'allow', turnId: input.turn_id, revision: s.revision }; return; }
      t.unchangedStops = t.lastStoppedRevision === s.revision ? t.unchangedStops + 1 : 1;
      t.lastStoppedRevision = s.revision;
      t.verdict = { decision: 'block', turnId: input.turn_id, revision: s.revision };
      // A broken checkpoint loop should expose failure, never burn indefinitely or mark work done.
      if (t.unchangedStops > 2) {
        output = { continue: false, stopReason: 'Project mainline check failed: no valid state change across repeated checks; task remains unfinished.' };
        return;
      }
      output = { decision: 'block', reason: (fresh ? 'The project still has executable work. Continue the recorded next action.\n' : 'Update and read back the project todo before finishing.\n') + prompt(s, session) };
    }
  }, dir);
  return output;
}

export function projectMainlineHooks(session, dir = CONFIG_DIR) {
  if (!session) return [];
  let binding;
  try { binding = JSON.parse(readFileSync(registry(session, dir), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  if (!binding?.enabled) return [];
  const command = [process.execPath, fileURLToPath(import.meta.url), 'hook', session, dir].map(quote).join(' ');
  return ['SessionStart', 'UserPromptSubmit', 'Stop', 'Interrupt'].map(event => ({ event, command,
    ...(event === 'SessionStart' ? { matcher: 'startup|resume|compact' } : {}), timeout: event === 'Interrupt' ? 3 : 30,
    ...(event === 'SessionStart' || event === 'UserPromptSubmit' ? { additionalContextLimit: 4000 } : {}) }));
}

export function mainlineFinalAllowed(session, turn, dir = CONFIG_DIR) {
  try {
    const binding = JSON.parse(readFileSync(registry(session, dir), 'utf8'));
    if (binding.enabled === false) return true;
    const s = JSON.parse(readFileSync(location(binding.projectId, dir), 'utf8'));
    const v = s.turns[session]?.verdict;
    return v?.decision === 'allow' && v.turnId === turn && v.revision === s.revision;
  } catch { return false; }
}

export async function runProjectTrack(args, dir = CONFIG_DIR) {
  if (!args.length || args.includes('--help')) return { usage: 'project-track assess|init|show|checkpoint|revise|binding --file <json> [--session <id>]; init (disabled by default): id,title,projectId,sessionId,enabled?,enableSourceRequestId?,request?,sop{document?,goal,scope,sourceRequestId,nodes[{id,title,source?,method,dependsOn,acceptance}]}; checkpoint: expectedRevision,inputToken,sourceRequestId,summary,decision,nodes,nextAction or wait{kind,owner,reason,resumeWhen,wakeRef}; revise: expectedRevision,reason,sop. assess: kind,domain?,object?,goal?,needsTracking?,sameProject?,sourceRequestId,evidence; binding: enabled,sourceRequestId,reason. Evidence is {path,sha256}. No schedule, training or robot operation is created.' };
  const [action] = args;
  const option = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : null;
  const session = option('--session') || process.env.REMOTELAB_SESSION_ID;
  const packet = option('--file') ? JSON.parse(await readFile(option('--file'), 'utf8')) : {};
  if (action === 'assess') return assessProjectRequest(packet, session ? await readMainline(id(session), dir) : null);
  if (action === 'binding') return setMainlineBinding(id(session), packet, dir);
  if (action === 'init') return initMainline(packet, dir);
  if (action === 'show') return showMainline(id(session), dir);
  if (action === 'checkpoint') return checkpointMainline(id(session), packet, dir);
  if (action === 'revise') return reviseMainline(id(session), packet, dir);
  throw Error('Unknown project-track command');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'hook') {
      let input = ''; for await (const chunk of process.stdin) input += chunk;
      process.stdout.write(JSON.stringify(await mainlineHook(process.argv[3], JSON.parse(input), process.argv[4] || CONFIG_DIR)));
    } else process.stdout.write(JSON.stringify(await runProjectTrack(process.argv.slice(2))) + '\n');
  } catch (e) {
    if (process.argv[2] === 'hook') process.stdout.write(JSON.stringify({ continue: false, stopReason: 'Project mainline check failed: ' + e.message }));
    else { console.error(e.message); process.exitCode = 1; }
  }
}
