import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, sep, isAbsolute } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { publishRecord, readRecord, records, fingerprint, safeId } from './feature-experiment-store.mjs';
import { requests } from './requests.mjs';
import { runDir, getRunResult } from './runs.mjs';
import { loadHistory } from './history.mjs';
import { readFeatureNativeReceipt } from './feature-observation.mjs';
import { projectResponseTiming, timingStats } from './response-timing.mjs';

export const KNOWLEDGE_ROOT = join(CONFIG_DIR, 'knowledge-pilot');
const sha = text => createHash('sha256').update(text).digest('hex');
const chars = text => [...text].length;
const executionId = r => r.nativeDispatchRunId || r.runId;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
export async function knowledgeConfig(root = KNOWLEDGE_ROOT) {
  const c = await readRecord(join(root, 'config.json'));
  if (!c) return null;
  if (c.version !== 1 || !safeId(c.id) || !safeId(c.projectId) || typeof c.enabled !== 'boolean'
    || !Array.isArray(c.personIds) || !c.personIds.length || c.personIds.some(p => !safeId(p))
    || !isAbsolute(c.corpusPath || '') || typeof c.name !== 'string' || c.name.length > 120
    || c.helpedLabel != null && (typeof c.helpedLabel !== 'string' || !c.helpedLabel.trim() || [...c.helpedLabel].length > 80 || /[\r\n]/.test(c.helpedLabel))
    || c.helpedCitation != null && c.helpedCitation !== 'finding-source') fail('Invalid knowledge pilot configuration');
  return c;
}
export function knowledgeEligible(c, o, session = {}) {
  return Boolean(c?.enabled && o.viewPersonId && o.initiatedByIdentityId && c.personIds.includes(o.viewPersonId)
    && !o.internalOperation && !o.automationTitle && !o.scheduleId && !o.triggerId && !o.workReference && !o.deliveryOnly
    && o.recordUserMessage !== false && !session.groupFeed && !session.internalRole);
}
export async function captureKnowledgePilot(options, session = {}, root = KNOWLEDGE_ROOT) {
  try {
    const c = await knowledgeConfig(root);
    return knowledgeEligible(c, options, session) ? { id: c.id, personId: options.viewPersonId,
      projectId: c.projectId, specHash: fingerprint(c), mode: 'on-demand',
      ...(c.helpedLabel ? {helpedLabel:c.helpedLabel} : {}),
      ...(c.helpedCitation ? {helpedCitation:c.helpedCitation} : {}) } : null;
  } catch (e) { console.warn('[knowledge-pilot] ' + e.message); return null; }
}
export function knowledgePilotPrompt(p, requestId) {
  if (!p) return '';
  const citation = p.helpedCitation === 'finding-source';
  const label = citation || p.helpedLabel ? `测试期标注：仅当本轮实际读到知识正文，并将其用于判断或行动、效果记录为 helped 时，${citation
    ? '在相关判断旁简短标注“【引用组织wiki中「具体条目」的发现：实际采用的发现；来源：具体原始来源】”。填写真实内容，不照抄占位词。以读取结果的 title、sources 和正文引用对应具体来源；有可用原件链接时附链接，不能把裸本机路径当可访问链接。区分材料提供者、Agent整理与原始证据：kuangzhi共享方法、团队报告、zijie讨论及官方源码按实际归属写，不把全库都归给同一个人。讨论或推断写成“讨论”或“待验证假设”，不能称为已验证发现；未核实作者时使用记录或项目名称，不猜姓名。同一发现只标注一次；不同发现各自对应来源。'
    : `在相关答复中标注一次 ${JSON.stringify(p.helpedLabel)}。`}只收到入口、只搜索目录、读后未采用或效果未知时不标注；不为添加标注而调用知识库。` : '';
  return `组织具身知识库按需试用，仅适用于本条已核发起人 ${p.personId}。范围：数据管线、预训练、后训练、评测诊断、真机部署。已有信息能推进就继续；需要历史经验时运行 remotelab knowledge search --query <问题>。结果同时提供词面命中和完整问题目录；结合标题与适用场景按含义选页，不限于命中项，不把排序当置信度。再用 remotelab knowledge read --page <返回的文件名> 先读最相关正文，必要时展开关联页、沿原证据核查；目录没找到不能证明原件中没有。无关问题无需查询，不自动加载整库正文。工具自动记录版本、返回量、次数和耗时。实际读取后，本轮结束前用 remotelab knowledge report --file <JSON路径> 记录一次 {effect:"helped|no_change|misled|unknown",reason:"改变了哪项判断，或为何没有帮助",evidenceSeqs:[原任务工具结果编号]}；这是Agent自评，不代表人的验收。${label}讨论和历史参数保留原适用条件，不提升为当前结论。当前输入 ${requestId}；多人补充时命令加 --request-id 指向实际使用知识的本人输入。`;
}
export async function observeKnowledgeAdmission(record, root = KNOWLEDGE_ROOT, now = Date.now(), explicit = false) {
  const c = await knowledgeConfig(root);
  if (!knowledgeEligible(c, record.options)) return null;
  const p = record.options?.knowledgePilot;
  if (!explicit && (!p || p.personId !== record.options.viewPersonId || p.id !== c.id)) return null;
  const key = fingerprint([record.sessionId, record.requestId]);
  const prompt = p ? knowledgePilotPrompt(p, record.requestId) : '';
  return publishRecord(join(root, c.id, 'inputs', key + '.json'), {
    sessionId: record.sessionId, requestId: record.requestId, runId: record.runId,
    personId: record.options.viewPersonId, at: now, entryPrepared: Boolean(p),
    entryChars: chars(prompt), entryBytes: Buffer.byteLength(prompt), entryHash: sha(prompt),
    verification: (c.verificationRequestIds || []).includes(record.requestId),
  });
}
async function corpusFile(c, file) {
  if (!/^[\w-]+\.(?:md|json)$/.test(file)) fail('Invalid knowledge page');
  const root = await realpath(c.corpusPath), path = await realpath(join(root, file));
  if (!path.startsWith(root + sep) || !(await stat(path)).isFile() || (await stat(path)).size > 512 * 1024) fail('Knowledge page outside corpus or too large');
  return readFile(path, 'utf8');
}
export async function queryKnowledge(record, input, {root = KNOWLEDGE_ROOT, now = Date.now()} = {}) {
  const c = await knowledgeConfig(root);
  if (!knowledgeEligible(c, record.options)) fail('Knowledge pilot is not enabled for this requester', 403);
  await observeKnowledgeAdmission(record, root, now, true);
  const started = performance.now();
  const indexText = await corpusFile(c, 'index.json'), index = JSON.parse(indexText);
  if (!Array.isArray(index.pages)) fail('Knowledge index unavailable');
  const eventId = input.operationId;
  if (!safeId(eventId)) fail('Operation ID required');
  const eventPath = join(root, c.id, 'events', fingerprint([record.sessionId, record.requestId, eventId]) + '.json');
  const prior = await readRecord(eventPath);
  const operationHash = fingerprint({action:input.action,page:input.page,query:input.query,report:input.report});
  if (prior) {
    if (prior.operationHash !== operationHash) fail('Operation ID was already used with different input', 409);
    return { ...prior.response, replayed: true };
  }
  let response, pageKind = null;
  if (input.action === 'search') {
    if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 1000) fail('Query required');
    const q = input.query.toLowerCase(), words = [...new Set(q.match(/[a-z0-9_-]+|[\p{Script=Han}]{2}/gu) || [])];
    const scored = index.pages.map(p => {
      const fields = [p.title, p.file, ...(p.aliases || [])].join(' ').toLowerCase();
      return { p, score: words.reduce((n, w) => n + Number(fields.includes(w)), 0)
        + (p.aliases || []).reduce((n, a) => n + (q.includes(a.toLowerCase()) ? 3 : 0), 0) };
    }).filter(p => p.score > 0).sort((a,b) => b.score - a.score).slice(0, 8);
    // Small pilot corpus: expose every question so vocabulary differences cannot
    // remove it before the Harness makes a semantic choice. Matches remain only
    // lexical hints; neither catalog visibility nor rank proves relevance.
    const catalog = index.pages.map(p => ({file:p.file, title:p.title, whenToUse:p.whenToUse || ''}));
    response = { version:index.version, indexHash:sha(indexText), retrievalStrategy:'catalog-routing-v1',
      matches:scored.map(({p}) => ({file:p.file,title:p.title,aliases:p.aliases})),
      catalogComplete:true, catalog,
      note:(scored.length ? '' : '没有词面命中。') + 'matches仅为词面提示；请按问题含义从完整catalog选页读取，不限于命中项。目录不是正文证据，未匹配不能证明没有相关经验。' };
  } else if (input.action === 'read') {
    const allowed = new Set(['README.md','CONFIDENCE.md','sources.md', ...index.pages.map(p => p.file)]);
    if (!allowed.has(input.page)) fail('Page is not in the current knowledge index');
    const text = await corpusFile(c, input.page);
    pageKind = index.pages.some(p => p.file === input.page) ? 'body' : 'index';
    const page = index.pages.find(p => p.file === input.page);
    response = { version:index.version, page:input.page, kind:pageKind,
      ...(page ? {title:page.title, sources:page.sources || []} : {}),
      sha256:sha(text), chars:chars(text), bytes:Buffer.byteLength(text), text };
  } else if (input.action === 'report') {
    const v = input.report;
    if (!v || !['helped','no_change','misled','unknown'].includes(v.effect) || typeof v.reason !== 'string'
      || !v.reason.trim() || v.reason.length > 2000 || !Array.isArray(v.evidenceSeqs) || v.evidenceSeqs.length > 20
      || v.evidenceSeqs.some(n => !Number.isSafeInteger(n) || n < 1)) fail('Effect, concrete reason and evidenceSeqs required');
    const events = (await records(join(root, c.id, 'events'))).items;
    if (!events.some(e => e.sessionId === record.sessionId && e.requestId === record.requestId && e.action === 'read')) fail('Read a page before reporting its effect');
    const evidence = (await Promise.all(v.evidenceSeqs.map(seq => loadHistory(record.sessionId, {fromSeq:seq,toSeq:seq,includeBodies:false})))).flat();
    const valid = new Set(evidence.filter(e => ['tool_result','artifact','file_change','attachment_delivery'].includes(e.type)).map(e => e.seq));
    if (v.evidenceSeqs.some(seq => !valid.has(seq)) || v.effect !== 'unknown' && !v.evidenceSeqs.length) fail('Use existing tool or artifact evidence for the effect');
    response = { effect:v.effect, reason:v.reason, evidenceSeqs:v.evidenceSeqs, evidenceLevel:'agent_report_with_event_refs' };
  } else fail('Use search, read or report');
  const serialized = JSON.stringify(response);
  const saved = await publishRecord(eventPath, { id:eventId, operationHash, sessionId:record.sessionId, requestId:record.requestId,
    runId:executionId(record), at:now, action:input.action, page:input.page || null, pageKind,
    version:index.version, responseChars:chars(serialized), responseBytes:Buffer.byteLength(serialized),
    bodyChars:pageKind === 'body' ? response.chars : 0, elapsedMs:performance.now()-started,
    responseHash:sha(serialized), response });
  if (saved.operationHash !== operationHash) fail('Operation ID was already used with different input',409);
  return saved.response;
}

// Thread counters include older tasks. Remove the prefix preceding the first
// current-run call using that event's last-call counters. Never call whole-run
// consumption the incremental price of knowledge.
export async function readKnowledgeRunMetrics(runId) {
  try {
    const path = join(runDir(runId), 'spool.jsonl');
    if ((await stat(path)).size > 64 * 1024 * 1024) return {usage:null};
    let before, last, invalid = false;
    const keys = ['inputTokens','cachedInputTokens','outputTokens'];
    for await (const line of createInterface({input:createReadStream(path),crlfDelay:Infinity})) {
      let row, e; try {row=JSON.parse(line);e=row.json || JSON.parse(row.line || '{}');} catch {continue;}
      if (e.type !== 'remotelab.context_metrics' || !e.featureUsage) continue;
      const u=e.featureUsage;
      if (keys.some(k => !Number.isSafeInteger(u[k]) || u[k] < 0)) {invalid=true;continue;}
      if (!before) {
        if (keys.some(k => !Number.isSafeInteger(e[k]) || e[k] < 0 || e[k] > u[k])) {invalid=true;continue;}
        before={threadId:u.threadId,...Object.fromEntries(keys.map(k=>[k,u[k]-e[k]]))};
      }
      if (u.threadId !== before.threadId || keys.some(k=>u[k] < (last || before)[k])) invalid=true;
      last=u;
    }
    const result=await getRunResult(runId);
    return {completedAt:result?.completedAt || null, usage:before && last && !invalid
      ? {...Object.fromEntries(keys.map(k=>[k,last[k]-before[k]])),source:'provider_run_counter_delta'} : null};
  } catch { return {usage:null}; }
}
export async function readKnowledgeObservations({root=KNOWLEDGE_ROOT, lookup=requests.byRequest,
  meter=readKnowledgeRunMetrics, nativeReceipt=readFeatureNativeReceipt, now=Date.now()}={}) {
  const c=await knowledgeConfig(root);
  if (!c) return null;
  const inputs=await records(join(root,c.id,'inputs')), log=await records(join(root,c.id,'events'));
  const production=inputs.items.filter(r=>!r.verification), verification=inputs.items.filter(r=>r.verification);
  const rows=[], runs=new Map();
  for (const row of production) {
    const r=await lookup(row.sessionId,row.requestId), runId=r ? executionId(r) : row.runId;
    if (!runs.has(runId)) {
      // Finished provider counters are immutable; do not rescan every old
      // spool on every existing dashboard refresh.
      const cachePath=join(root,c.id,'completed-runs',runId+'.json');
      const cached=await readRecord(cachePath);
      const value=cached || await meter(runId);
      if (!cached && value.completedAt && value.usage) await publishRecord(cachePath,value);
      runs.set(runId,value);
    }
    const own=log.items.filter(e=>e.sessionId===row.sessionId && e.requestId===row.requestId);
    const reads=own.filter(e=>e.action==='read'), bodies=reads.filter(e=>e.pageKind==='body');
    const reports=own.filter(e=>e.action==='report').sort((a,b)=>a.at-b.at);
    const timing=r ? projectResponseTiming(r) : null, end=r?.settledAt ? Date.parse(r.settledAt) : null;
    rows.push({...row,runId, received:r?.nativeReceipt?.accepted === true || Boolean(r && !r.nativeDispatchRunId && await nativeReceipt(runId)),
      state:!r?'missing_request':end?'finished':'running', searches:own.filter(e=>e.action==='search').length,
      readCalls:reads.length, bodyReadCalls:bodies.length, uniquePages:new Set(bodies.map(e=>e.page)).size,
      bodyChars:bodies.reduce((n,e)=>n+e.bodyChars,0), returnChars:own.filter(e=>e.action!=='report').reduce((n,e)=>n+e.responseChars,0),
      readLatency:timingStats(reads.map(e=>e.elapsedMs)), effect:reports.at(-1)?.response || null,
      firstContentMs:timing?.firstContentAt ? timing.firstContentAt-row.at : null,
      firstReplyMs:timing?.firstReplyAt ? timing.firstReplyAt-row.at : null,
      completionMs:end ? end-row.at : null});
  }
  const measured=[...runs.values()].filter(r=>r.usage), sum=k=>measured.length?measured.reduce((n,r)=>n+r.usage[k],0):null;
  const totals={entryPrepared:rows.filter(r=>r.entryPrepared).length, received:rows.filter(r=>r.received).length,
    entryChars:rows.reduce((n,r)=>n+r.entryChars,0), searches:rows.reduce((n,r)=>n+r.searches,0),
    readCalls:rows.reduce((n,r)=>n+r.readCalls,0), bodyReadCalls:rows.reduce((n,r)=>n+r.bodyReadCalls,0),
    bodyChars:rows.reduce((n,r)=>n+r.bodyChars,0), returnChars:rows.reduce((n,r)=>n+r.returnChars,0),
    readInputs:rows.filter(r=>r.bodyReadCalls>0).length, noReadInputs:rows.filter(r=>!r.bodyReadCalls).length,
    repeatedReads:rows.reduce((n,r)=>n+r.bodyReadCalls-r.uniquePages,0),
    effects:Object.fromEntries(['helped','no_change','misled','unknown'].map(v=>[v,rows.filter(r=>r.effect?.effect===v).length])),
    missingEffect:rows.filter(r=>r.readCalls && !r.effect).length};
  const timing={firstContent:timingStats(rows.map(r=>r.firstContentMs)),firstReply:timingStats(rows.map(r=>r.firstReplyMs)),
    completion:timingStats(rows.map(r=>r.completionMs)), read:timingStats(log.items.filter(e=>e.action==='read' && production.some(r=>r.sessionId===e.sessionId && r.requestId===e.requestId)).map(e=>e.elapsedMs))};
  const daily=[...new Set(rows.map(r=>new Date(r.at+8*3600000).toISOString().slice(0,10)))].sort().map(day=>{
    const a=rows.filter(r=>new Date(r.at+8*3600000).toISOString().slice(0,10)===day);
    return {day,inputs:a.length,readInputs:a.filter(r=>r.bodyReadCalls).length,bodyReadCalls:a.reduce((n,r)=>n+r.bodyReadCalls,0),bodyChars:a.reduce((n,r)=>n+r.bodyChars,0)};
  });
  return {id:c.id,projectId:c.projectId,featureId:'organization-knowledge',name:c.name,
    state:c.enabled?'observing':'paused',scopeLabel:'已明确启用的本人输入；数据、预训练、后训练、评测与真机问题按需调用',
    startedAt:c.enabledAt, admittedInputs:rows.length, totals,timing,daily,
    verification:{inputs:verification.length,events:log.items.filter(e=>verification.some(r=>r.sessionId===e.sessionId && r.requestId===e.requestId)).length},
    usage:{measured:measured.length,unknown:runs.size-measured.length,runs:runs.size,inputTokens:sum('inputTokens'),
      cachedInputTokens:sum('cachedInputTokens'),outputTokens:sum('outputTokens'),
      uncachedInputTokens:measured.length?sum('inputTokens')-sum('cachedInputTokens'):null,
      incrementalTokens:null,payloadTokens:null},
    partial:inputs.partial || log.partial, inputRecords:rows,records:log.items,
    semantics:'入口提供、原生接收、正文读取与效果分别统计；不查正文不等于漏用。载荷计字符，未取得分段Tokenizer回执时不冒充精确Token。Token按执行去重，为关联整轮用量（共享执行可能含补充输入），不是知识库净增代价；净增需对照，当前未知。首响沿实际投递回执，Web或缺回执保持未知。效果为带原事件引用的Agent自评，未报告与未知保留；安装验证不计自然样本。直接绕过工具读文件及压缩后保留量不在本工具覆盖内。'};
}
