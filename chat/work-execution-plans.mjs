// The Harness interprets input and human decisions. This module stores the
// bounded plan, validates its provenance, and transports accepted work/results.
import { createHash } from 'node:crypto';
import { serialQueue } from '../lib/durable-records.mjs';
import { routingPilotScope, isPilotInputSinceActivation } from '../lib/group-routing-pilot.mjs';
import { findSessionMeta, loadSessionsMeta, mutateSessionMeta } from './session-meta-store.mjs';
import { requests } from './requests.mjs';
import { appendEvent } from './history.mjs';
import { verifiedWorkActor } from './work-awareness.mjs';
import { readNativeQuestion } from './native-user-questions.mjs';
import { runDir } from './runs.mjs';
import { enqueueSourceDelivery } from './source-deliveries.mjs';
import { buildSessionNavigationHref } from '../lib/session-navigation.mjs';

const serial = serialQueue();
const hash = text => createHash('sha256').update(text).digest('hex').slice(0, 20);
const clean = (value, max = 6000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const fail = message => { throw new Error(message); };
const terminal = state => ['completed', 'failed', 'cancelled', 'skipped', 'blocked'].includes(state);
const plans = session => session?.workAwareness?.executionPlans || [];
const manager = async deps => deps || await import('./session-manager.mjs');
async function save(sessionId, change) {
  const result = await mutateSessionMeta(sessionId, draft => {
    draft.workAwareness ||= { version: 1, revision: 0, works: [], intents: [], suggestions: [] };
    draft.workAwareness.executionPlans ||= [];
    change(draft.workAwareness);
    draft.workAwareness.revision++;
    return true;
  });
  return result.meta;
}
async function actorFor(record, { existing = false } = {}) {
  const o = record?.options || {};
  const actor = verifiedWorkActor(o.viewPersonId, o.initiatedByIdentityId);
  if (!actor || record.result || record.releasedAt || o.internalOperation || o.automationTitle
      || o.recordUserMessage === false || o.workPlanChild || o.workPlanReview
      || o.feishuConnectorAuthenticated !== true || o.sourceContext?.connector !== 'feishu'
      || ['app', 'bot'].includes(o.sourceContext?.sender?.senderType)) fail('A current accepted human input is required');
  const source = await findSessionMeta(record.sessionId);
  const scope = await routingPilotScope(source?.conversation, undefined, actor.personId);
  if (!scope || scope.version !== 2 || !isPilotInputSinceActivation(scope, o.sourceContext.createTime || o.sourceContext.eventTs)) {
    fail('Input is outside the personal execution trial');
  }
  if (!existing && (o.messageRoutingPolicy?.trialId !== scope.trialId
      || o.messageRoutingPolicy?.mechanism !== 'experimental')) fail('Execution trial is disabled for this input');
  return { actor, source, scope };
}
function validateBranches(branches) {
  if (!Array.isArray(branches) || branches.length < 1 || branches.length > 4) fail('A plan has 1–4 branches');
  const result = branches.map(b => ({ id: clean(b.id, 30), name: clean(b.name, 100), task: clean(b.task),
    writeScope: clean(b.writeScope, 600), dependsOn: b.dependsOn || [], state: 'pending' }));
  const seen = new Set();
  for (const b of result) {
    if (!/^[a-z][a-z0-9_]{0,29}$/.test(b.id) || seen.has(b.id) || !b.name || !b.task || !b.writeScope
        || !Array.isArray(b.dependsOn) || b.dependsOn.some(id => !seen.has(id))
        || new Set(b.dependsOn).size !== b.dependsOn.length) fail('Branches need unique IDs, task, write scope and earlier dependencies (no cycles)');
    seen.add(b.id);
  }
  return result;
}
export async function readExecutionPlans(session) {
  return Promise.all(plans(session).map(async plan => {
    const p = structuredClone(plan);
    for (const b of p.branches) if (b.sessionId && b.requestId && b.state === 'running') {
      const r = await requests.byRequest(b.sessionId, b.requestId);
      b.runtimeState = r?.result?.state || (r?.preparedAt ? 'running' : 'queued');
      const q = r && await readNativeQuestion(runDir(r.nativeDispatchRunId || r.runId));
      if (q?.state === 'pending') { b.runtimeState = 'waiting'; b.pendingQuestion = q; }
    }
    return p;
  }));
}

export async function handleExecutionPlan(record, body, deps) {
  return serial(async () => {
    record = await requests.get(record.key) || record;
    const { actor, source, scope } = await actorFor(record, { existing: ['approve', 'stop', 'amend', 'answer', 'resume'].includes(body.action) });
    if (body.action === 'record') {
      const decision = { requestId: record.requestId, at: new Date().toISOString(), actor,
        understanding: clean(body.understanding, 600), intent: clean(body.intent, 80),
        where: clean(body.where, 300), approach: clean(body.approach, 300), reason: clean(body.reason, 600) };
      if (['understanding', 'intent', 'where', 'approach', 'reason'].some(key => !decision[key])) fail('Explain the input, destination, approach and reason');
      await save(source.id, data => { data.inputDecisions = [...(data.inputDecisions || []).filter(d => d.requestId !== record.requestId), decision].slice(-32); });
      await appendEvent(source.id, { type: 'work_event', action: 'input-decision', decision });
      return { decision };
    }
    if (['propose', 'start'].includes(body.action)) {
      const goal = clean(body.goal, 600), context = clean(body.context, 6000), reason = clean(body.reason, 1000);
      const branches = validateBranches(body.branches);
      if (!goal || !reason || !context) fail('A proposal needs goal, reason and bounded source context/constraints');
      if (body.action === 'start' && (branches.length !== 1 || !clean(body.authorization, 1000))) fail('Direct start needs one explicitly requested task and its authorization basis');
      if ((source.delegationDepth || 0) >= 2) fail('A delegated child cannot recursively create execution plans');
      const id = 'plan_' + hash(JSON.stringify([source.id, record.requestId, body.action, goal, context, reason, branches]));
      const old = plans(source).find(p => p.id === id);
      if (old) { await advancePlan(source.id, id, deps); return { plan: plans(await findSessionMeta(source.id)).find(p => p.id === id), duplicate: true }; }
      if (plans(source).length >= 32) fail('Plan limit reached; continue an existing plan');
      const plan = { id, state: 'draft', version: 1, goal, context, reason, branches, actor, trialId: scope.trialId,
        sourceSessionId: source.id, sourceRequestId: record.requestId, createdAt: new Date().toISOString(),
        runtimeSelection: record.runtimeSelection, folder: source.folder,
        returnPlan: record.deliveryPlan || record.options.sourceDelivery, controls: [] };
      if (body.action === 'start') Object.assign(plan, { state: 'approved', selected: [branches[0].id],
        approvalRequestId: record.requestId, approvalText: clean(record.options.recordedUserText || record.text, 3000),
        approval: clean(body.authorization, 1000) });
      await save(source.id, data => data.executionPlans.push(plan));
      await appendEvent(source.id, { type: 'work_event', action: body.action === 'start' ? 'execution-plan-started' : 'execution-plan-proposed', plan });
      if (body.action === 'start') await advancePlan(source.id, id, deps);
      return { plan: plans(await findSessionMeta(source.id)).find(p => p.id === id), boundary: body.action === 'start'
        ? 'The explicitly requested single task was submitted; check actual state before reporting completion.'
        : 'Draft only; no Session created. Offer the proposal asynchronously and continue already authorized work in the source Session without waiting. Before a later approval, reconcile source progress so completed or active work is not duplicated.' };
    }
    let plan = plans(source).find(p => p.id === body.planId);
    if (!plan || plan.actor.personId !== actor.personId) fail('Select this requester’s plan in this source conversation');
    if (body.action === 'approve') {
      if (plan.approvalRequestId === record.requestId) {
        if (JSON.stringify(plan.selected) !== JSON.stringify(body.selected)) fail('Retry must preserve selected branches');
        await advancePlan(source.id, plan.id, deps);
        return { plan: plans(await findSessionMeta(source.id)).find(p => p.id === plan.id), duplicate: true };
      }
      if (plan.state !== 'draft' || body.expectedVersion !== plan.version) fail('Proposal changed; review its current version');
      if (record.requestId === plan.sourceRequestId || Date.parse(record.acceptedAt) < Date.parse(plan.createdAt)) fail('Approval needs a subsequent human input after the concrete proposal');
      const selected = body.selected;
      if (!Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length
          || selected.some(id => !plan.branches.some(b => b.id === id && !b.stopRequested))
          || plan.branches.some(b => selected.includes(b.id) && b.dependsOn.some(id => !selected.includes(id)))) fail('Select branches together with their dependencies');
      const approval = clean(body.approval, 1000);
      if (!approval) fail('Explain how this actual human reply confirms the selected proposal; do not infer approval from silence');
      await save(source.id, data => {
        const p = data.executionPlans.find(p => p.id === plan.id);
        Object.assign(p, { state: 'approved', selected, approvalRequestId: record.requestId,
          approvalText: clean(record.options.recordedUserText || record.text, 3000), approval, version: p.version + 1 });
        for (const b of p.branches) if (!selected.includes(b.id)) b.state = 'skipped';
      });
      await appendEvent(source.id, { type: 'work_event', action: 'execution-plan-approved', planId: plan.id,
        requestId: record.requestId, selected, actor, approval });
      await advancePlan(source.id, plan.id, deps);
    } else if (body.action === 'answer') {
      const b = plan.branches.find(b => b.id === body.branchId);
      if (!b || b.state !== 'running' || b.stopRequested) fail('Select a running branch with a pending question');
      const child = await requests.byRequest(b.sessionId, b.requestId);
      const question = child && await readNativeQuestion(runDir(child.nativeDispatchRunId || child.runId));
      if (question?.state !== 'pending' || question.id !== body.questionId || !clean(body.text, 3000)) fail('Question changed; read the pending question before relaying the human answer');
      const requestId = 'plan-answer:' + hash(record.requestId + ':' + question.id);
      const api = await manager(deps);
      const prior = await requests.byRequest(b.sessionId, requestId);
      const receipt = await api.submitHttpMessage(b.sessionId, prior?.text || body.text, [], prior?.options || {
        requestId, nativeQuestionId: question.id, viewPersonId: actor.personId, initiatedByIdentityId: actor.identityId,
        recordUserMessage: false, suppressSourceDelivery: true, ...plan.runtimeSelection,
        workPlanChild: { sourceSessionId: source.id, planId: plan.id, branchId: b.id },
        sourceContext: { connector: 'work-plan-answer', sourceSessionId: source.id, sourceRequestId: record.requestId },
      });
      await appendEvent(source.id, { type: 'work_event', action: 'execution-question-answered', planId: plan.id,
        branchId: b.id, sourceRequestId: record.requestId, targetRequestId: receipt.requestId, questionId: question.id });
    } else if (['stop', 'amend'].includes(body.action)) {
      const selected = body.selected;
      if (!Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length
          || selected.some(id => !plan.branches.some(b => b.id === id))) fail('Select the exact affected branches');
      const text = clean(body.text, 3000);
      if (!text) fail('Describe the human’s correction or stop instruction');
      const id = 'control_' + hash(JSON.stringify([plan.id, record.requestId, body.action, selected, text]));
      const old = plan.controls.find(c => c.requestId === record.requestId);
      if (old && old.id !== id) fail('Retry must preserve the control packet');
      if (!old) {
        if (body.expectedVersion !== plan.version) fail('Plan changed; inspect current progress before controlling it');
        if (plan.state === 'draft' && body.action !== 'stop') fail('Revise the proposal before starting work');
        if (body.action === 'amend' && selected.some(id => !['pending', 'running'].includes(plan.branches.find(b => b.id === id).state))) {
          fail('Completed or stopped branches need a new reviewed follow-up plan');
        }
        await save(source.id, data => {
          const p = data.executionPlans.find(p => p.id === plan.id);
          p.controls.push({ id, requestId: record.requestId, action: body.action, selected, text,
            actor, state: 'pending', at: new Date().toISOString() });
          p.version++;
          if (body.action === 'stop') for (const b of p.branches) if (selected.includes(b.id)) {
            b.stopRequested = true;
            if (b.state === 'pending') b.state = 'cancelled';
          }
          if (body.action === 'stop' && p.branches.every(b => b.stopRequested || b.state === 'skipped')) p.state = 'stopping';
        });
      }
      if (body.action === 'stop' && plan.reviewRunId) {
        const api = await manager(deps);
        await api.cancelActiveRun(source.id, { expectedRunId: plan.reviewRunId });
      }
      await applyControls(source.id, plan.id, deps);
      await advancePlan(source.id, plan.id, deps);
    } else if (body.action === 'resume') {
      await applyControls(source.id, plan.id, deps);
      await advancePlan(source.id, plan.id, deps);
    } else fail('Use propose, start, approve, record, amend, answer, stop or resume');
    return { plan: plans(await findSessionMeta(source.id)).find(p => p.id === plan.id) };
  });
}

async function applyControls(sourceId, planId, deps) {
  let plan = plans(await findSessionMeta(sourceId)).find(p => p.id === planId);
  const api = await manager(deps);
  for (const control of plan.controls.filter(c => c.state === 'pending')) {
    for (const id of control.selected) {
      const b = plan.branches.find(b => b.id === id);
      if (!b.sessionId || terminal(b.state)) continue;
      if (control.action === 'stop') {
        // A correction may be queued behind a still-running original. Cancel
        // every accepted input owned by this branch, never an unrelated run.
        const owned = (await requests.active()).filter(r => r.sessionId === b.sessionId && !r.result
          && r.options?.workPlanChild?.planId === planId && r.options.workPlanChild.branchId === b.id);
        for (const runId of new Set(owned.map(r => r.nativeDispatchRunId || r.runId))) {
          await api.cancelActiveRun(b.sessionId, { expectedRunId: runId });
        }
      } else {
        const requestId = control.id + ':' + b.id;
        const old = await requests.byRequest(b.sessionId, requestId);
        await api.submitHttpMessage(b.sessionId, old?.text || `主话题中人的补充（来源 ${sourceId}，输入 ${control.requestId}）：\n${control.text}\n保持原任务及范围，说明这次补充怎样影响结果。`, [], old?.options || {
          requestId, ...plan.runtimeSelection, viewPersonId: control.actor.personId,
          initiatedByIdentityId: control.actor.identityId, recordUserMessage: false,
          workPlanChild: { sourceSessionId: sourceId, planId, branchId: b.id },
          suppressSourceDelivery: true, sourceContext: { connector: 'work-plan', sourceSessionId: sourceId },
        });
        await save(sourceId, data => {
          const branch = data.executionPlans.find(p => p.id === planId).branches.find(b => b.id === id);
          branch.requestId = requestId; // completion of an older input cannot close the corrected branch
        });
      }
    }
    await save(sourceId, data => { data.executionPlans.find(p => p.id === planId).controls.find(c => c.id === control.id).state = 'submitted'; });
    plan = plans(await findSessionMeta(sourceId)).find(p => p.id === planId);
  }
}

async function advancePlan(sourceId, planId, deps) {
  let source = await findSessionMeta(sourceId), plan = plans(source).find(p => p.id === planId);
  if (!plan || !['approved', 'running', 'stopping'].includes(plan.state) || source.archived) return;
  const api = await manager(deps);
  // Stable Session and Request keys make partial admission recoverable on restart.
  for (const branch of plan.branches) {
    if (branch.state !== 'pending' || branch.stopRequested || plan.state === 'stopping') continue;
    const dependencies = branch.dependsOn.map(id => plan.branches.find(b => b.id === id));
    if (dependencies.some(b => terminal(b.state) && b.state !== 'completed')) {
      await save(sourceId, data => { data.executionPlans.find(p => p.id === planId).branches.find(b => b.id === branch.id).state = 'blocked'; });
      branch.state = 'blocked'; continue;
    }
    if (dependencies.some(b => b.state !== 'completed')) continue;
    const target = branch.sessionId ? await findSessionMeta(branch.sessionId) : await api.createSession(plan.folder,
      plan.runtimeSelection?.tool || source.tool, branch.name, { ...plan.runtimeSelection,
        sourceId: 'chat', initiatedByIdentityId: plan.actor.identityId, viewPersonId: plan.actor.personId,
        delegatedFromSessionId: sourceId, delegationDepth: (source.delegationDepth || 0) + 1,
        externalTriggerId: 'work-plan:' + plan.id + ':' + branch.id });
    if (!target || target.archived) fail('The planned child Session is unavailable');
    const requestId = 'work-plan:' + plan.id + ':' + branch.id;
    await save(sourceId, data => { Object.assign(data.executionPlans.find(p => p.id === planId).branches.find(b => b.id === branch.id), {
      sessionId: target.id, sessionUrl: buildSessionNavigationHref(target.id), requestId }); });
    const amendments = plan.controls.filter(c => c.action === 'amend' && c.selected.includes(branch.id)).map(c => c.text).join('\n');
    const text = `经人确认的独立分工。主话题：${sourceId}；方案：${plan.id}；分支：${branch.id}。\n总目标：${plan.goal}\n已确定的背景、约束和来源：\n${plan.context}\n你的任务：${branch.task}\n修改范围：${branch.writeScope}\n${amendments ? '人的后续补充：\n' + amendments : ''}\n${dependencies.length ? '前置结果（需按原证据核对）：\n' + dependencies.map(b => `${b.name} (${b.sessionId}): ${b.result}`).join('\n') : ''}\n仅执行这份分工。不要递归拆分、向其他群发消息或扩大授权。最终返回成果、证据、未解决问题，系统负责回到主话题。需要人补充时使用原生提问，主话题可查到等待状态，不能替人确认。`;
    const prior = await requests.byRequest(target.id, requestId);
    const receipt = await api.submitHttpMessage(target.id, prior?.text || text, [], prior?.options || {
      requestId, ...plan.runtimeSelection, viewPersonId: plan.actor.personId, initiatedByIdentityId: plan.actor.identityId,
      recordUserMessage: false, suppressSourceDelivery: true,
      workPlanChild: { sourceSessionId: sourceId, planId, branchId: branch.id },
      sourceContext: { connector: 'work-plan', sourceSessionId: sourceId },
    });
    await save(sourceId, data => {
      const p = data.executionPlans.find(p => p.id === planId);
      p.state = 'running'; Object.assign(p.branches.find(b => b.id === branch.id), { state: 'running', runId: receipt.run.id });
    });
    branch.state = 'running';
  }
  source = await findSessionMeta(sourceId); plan = plans(source).find(p => p.id === planId);
  if (!plan.branches.every(b => terminal(b.state))) return;
  if (plan.state === 'stopping' || plan.branches.every(b => ['cancelled', 'skipped'].includes(b.state))) {
    await save(sourceId, data => { data.executionPlans.find(p => p.id === planId).state = 'cancelled'; });
    return; // A stop cannot wake the parent or restart its work.
  }
  const requestId = 'work-plan-review:' + plan.id;
  const text = `已确认方案 ${plan.id} 的选定分支已结束，请在主话题核验并汇总。\n原目标：${plan.goal}\n原范围与来源：${plan.context}\n${plan.branches.filter(b => b.state !== 'skipped').map(b => `${b.name} (${b.id}, Session ${b.sessionId || '未启动'})：${b.state}\n${b.result || b.error || '没有成果；不能认定完成。'}`).join('\n\n')}\n这次只核验和整合已有成果，回复原交办者。执行结束不等于业务验收；缺口、冲突和失败必须说明。不要自行重新开工、恢复停止分支或发布到其他群；人的后续决定优先。`;
  const prior = await requests.byRequest(sourceId, requestId);
  const receipt = await api.submitHttpMessage(sourceId, prior?.text || text, [], prior?.options || {
    requestId, ...plan.runtimeSelection, viewPersonId: plan.actor.personId, initiatedByIdentityId: plan.actor.identityId,
    allowGroupFeedWrite: true, recordUserMessage: false, workPlanReview: { sourceSessionId: sourceId, planId },
    sourceContext: { connector: 'work-plan-review', sourceSessionId: sourceId }, sourceDelivery: plan.returnPlan,
  });
  await save(sourceId, data => { Object.assign(data.executionPlans.find(p => p.id === planId), { state: 'reviewing', reviewRequestId: requestId, reviewRunId: receipt.run.id }); });
}

export async function completeExecutionPlan(record, run, deps) {
  if (!record?.options?.workPlanChild && !record?.options?.workPlanReview) return;
  return serial(async () => {
    const ref = record.options.workPlanChild || record.options.workPlanReview;
    const source = await findSessionMeta(ref.sourceSessionId);
    const plan = plans(source).find(p => p.id === ref.planId);
    if (!plan) return;
    if (record.options.workPlanReview) {
      if (['cancelled', 'stopping'].includes(plan.state)) return;
      await save(source.id, data => { Object.assign(data.executionPlans.find(p => p.id === plan.id), {
        state: record.result?.state === 'completed' ? 'reviewed' : 'review-failed',
        reviewResult: clean(record.result?.payload?.text, 10000), reviewResultState: record.result?.state,
      }); });
      return;
    }
    const branch = plan.branches.find(b => b.id === ref.branchId);
    if (!branch || branch.sessionId !== record.sessionId) return;
    if (branch.stopRequested) {
      const outstanding = (await requests.active()).some(r => r.sessionId === branch.sessionId && !r.result
        && r.options?.workPlanChild?.planId === plan.id && r.options.workPlanChild.branchId === branch.id);
      if (outstanding) return; // cancellation request is not terminal evidence
    } else if (branch.requestId !== record.requestId) return;
    const result = clean(record.result?.payload?.text, 12000);
    const state = branch.stopRequested ? 'cancelled' : record.result?.state === 'completed' && result ? 'completed'
      : record.result?.state === 'cancelled' ? 'cancelled' : 'failed';
    await save(source.id, data => { Object.assign(data.executionPlans.find(p => p.id === plan.id).branches.find(b => b.id === branch.id), {
      state, result, error: clean(record.result?.error || (!result ? 'No usable result' : ''), 1000), completedAt: new Date().toISOString(),
    }); });
    await appendEvent(source.id, { type: 'work_event', action: 'execution-branch-result', planId: plan.id, branchId: branch.id,
      targetSessionId: record.sessionId, targetRequestId: record.requestId, runId: run?.id, state });
    await advancePlan(source.id, plan.id, deps);
  });
}

export async function validateExecutionPlanRequest(record) {
  const ref = record.options?.workPlanChild || record.options?.workPlanReview;
  if (!ref) return;
  const source = await findSessionMeta(ref.sourceSessionId);
  const p = plans(source).find(p => p.id === ref.planId);
  if (!p || source.archived || ['cancelled', 'stopping', 'draft'].includes(p.state)) fail('Execution plan is no longer active; do not restart cancelled work');
  if (record.options.workPlanChild) {
    const b = p.branches.find(b => b.id === ref.branchId);
    if (!b || b.stopRequested || b.sessionId !== record.sessionId) fail('This branch was stopped or replaced');
  }
}

export async function recoverExecutionPlans(deps) {
  // Event-driven boot recovery; no watcher, polling job or semantic model.
  for (const source of await loadSessionsMeta()) for (const plan of plans(source)) {
    if (source.archived || !['approved', 'running', 'stopping'].includes(plan.state)) continue;
    try {
      await serial(() => applyControls(source.id, plan.id, deps));
      const current = plans(await findSessionMeta(source.id)).find(p => p.id === plan.id);
      for (const branch of current.branches) if (branch.sessionId && branch.requestId) {
        const record = await requests.byRequest(branch.sessionId, branch.requestId);
        if (record?.result) await completeExecutionPlan(record, { id: record.runId }, deps);
      }
      await serial(async () => { await applyControls(source.id, plan.id, deps); await advancePlan(source.id, plan.id, deps); });
    } catch (error) {
      await appendEvent(source.id, { type: 'work_event', action: 'execution-plan-recovery-failed', planId: plan.id, error: error.message });
    }
  }
}

export async function forwardExecutionQuestions(record, events) {
  const ref = record?.options?.workPlanChild;
  if (!ref) return;
  const source = await findSessionMeta(ref.sourceSessionId);
  const p = plans(source).find(p => p.id === ref.planId), b = p?.branches.find(b => b.id === ref.branchId);
  if (!b || b.stopRequested || source.archived) return;
  for (const e of events) if (e.messageKind === 'user_question' && e.questionState === 'pending') {
    const question = e.nativeQuestion;
    if (!question || question.secret) continue;
    await enqueueSourceDelivery({ sessionId: source.id, responseId: 'plan-question:' + hash(p.id + ':' + e.questionId),
      sourceDelivery: p.returnPlan,
      text: `分支「${b.name}」需要你的回答：\n${question.question}\n${question.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? '：' + o.description : ''}`).join('\n')}\n\n可在本话题回复，并注明分支名称；其他独立分支继续运行。` });
    await appendEvent(source.id, { type: 'work_event', action: 'execution-question', planId: p.id,
      branchId: b.id, targetSessionId: record.sessionId, questionId: e.questionId, question });
  }
}
