// The Harness interprets input and human decisions. This module stores the
// bounded plan, validates its provenance, and transports accepted work/results.
import { acceptedParallelWorkPolicy } from './parallel-work-policy.mjs';
import { createHash } from 'node:crypto';
import { createKeyedTaskQueue } from './fs-utils.mjs';
import { routingPilotScope, isPilotInputSinceActivation } from '../lib/group-routing-pilot.mjs';
import { findSessionMeta, loadSessionsMeta, mutateSessionMeta } from './session-meta-store.mjs';
import { requests } from './requests.mjs';
import { appendEvent } from './history.mjs';
import { verifiedWorkActor } from './work-awareness.mjs';
import { readNativeQuestion } from './native-user-questions.mjs';
import { runDir } from './runs.mjs';
import { enqueueSourceDelivery, getSourceDelivery, resolveSourceDelivery } from './source-deliveries.mjs';
import { buildSessionNavigationHref } from '../lib/session-navigation.mjs';
import { groupWorkHref } from './group-sync-presentation.mjs';
import { normalizeConversation } from '../lib/conversation-target.mjs';
import { clipCompactionSection } from './session-context-compaction.mjs';

const serial = createKeyedTaskQueue();
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
  const parallel = acceptedParallelWorkPolicy(o);
  if (!existing && (parallel.version !== 1 || !parallel.enabled || parallel.trialId !== scope.trialId)) fail('Execution trial is disabled for this input');
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
// Keep a new branch in its accepted channel without inheriting the parent's
// thread anchor. Cross-group transfer remains a separate confirmed workflow.
function branchOrigin(record) {
  const origin = normalizeConversation(record.deliveryPlan || record.options.sourceDelivery);
  if (origin?.connector !== 'feishu' || origin.target.chatType !== 'group' || !origin.target.chatId) {
    fail('A Feishu group destination is required for this execution plan');
  }
  const target = { chatId: origin.target.chatId, chatType: 'group', conversationKind: 'thread' };
  for (const key of ['tenantKey', 'chatMode']) if (origin.target[key]) target[key] = origin.target[key];
  return { connector: 'feishu', sourceRouteId: origin.sourceRouteId, target };
}

export async function readExecutionPlans(session) {
  return Promise.all(plans(session).map(async plan => {
    const p = structuredClone(plan);
    for (const b of p.branches) if (b.state === 'pending' && b.topicDeliveryId) {
      const delivery = await getSourceDelivery(b.topicDeliveryId);
      b.runtimeState = 'waiting-for-topic';
      b.topicDeliveryState = delivery?.state || 'missing';
      if (delivery?.lastError) b.error = delivery.lastError;
    }
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
  const followUps = [];
  const result = await serial(record.sessionId, async () => {
    record = await requests.get(record.key) || record;
    const { actor, source, scope } = await actorFor(record, { existing: ['approve', 'stop', 'amend', 'continue', 'answer', 'resume'].includes(body.action) });
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
      const branchSurface = body.branchSurface || 'web-silent';
      if (!['web-silent', 'feishu-thread'].includes(branchSurface)) fail('branchSurface must be web-silent or feishu-thread');
      if (!goal || !reason || !context) fail('A proposal needs goal, reason and bounded source context/constraints');
      if (body.action === 'start' && (!clean(body.authorization, 1000)
          || branches.length > 1 && body.executionMode !== 'parallel-sessions')) {
        fail('Direct start needs explicit authorization; multiple tasks also need executionMode parallel-sessions for the human’s requested Session split');
      }
      if ((source.delegationDepth || 0) >= 2) fail('A delegated child cannot recursively create execution plans');
      const id = 'plan_' + hash(JSON.stringify([source.id, record.requestId, body.action, goal, context, reason, branches]));
      const old = plans(source).find(p => p.id === id);
      if (old && (old.branchSurface || 'web-silent') !== branchSurface) fail('Retry must preserve branchSurface');
      if (old) { followUps.push(() => advancePlan(source.id, id, deps)); return { plan: plans(await findSessionMeta(source.id)).find(p => p.id === id), duplicate: true }; }
      if (plans(source).length >= 32) fail('Plan limit reached; continue an existing plan');
      const plan = { id, state: 'draft', version: 1, goal, context, reason, branches, actor, trialId: scope.trialId,
        sourceSessionId: source.id, sourceRequestId: record.requestId, createdAt: new Date().toISOString(),
        runtimeSelection: record.runtimeSelection, folder: source.folder,
        returnPlan: record.deliveryPlan || record.options.sourceDelivery, controls: [],
        branchSurface, ...(branchSurface === 'feishu-thread' ? { branchOrigin: branchOrigin(record) } : {}) };
      if (body.action === 'start') Object.assign(plan, { state: 'approved', selected: branches.map(b => b.id),
        executionMode: branches.length > 1 ? 'parallel-sessions' : 'single-session',
        approvalRequestId: record.requestId, approvalText: clean(record.options.recordedUserText || record.text, 3000),
        approval: clean(body.authorization, 1000) });
      await save(source.id, data => data.executionPlans.push(plan));
      await appendEvent(source.id, { type: 'work_event', action: body.action === 'start' ? 'execution-plan-started' : 'execution-plan-proposed', plan });
      if (body.action === 'start') followUps.push(() => advancePlan(source.id, id, deps));
      return { plan: plans(await findSessionMeta(source.id)).find(p => p.id === id), boundary: body.action === 'start'
        ? 'The explicitly requested branches were accepted. Only explicit feishu-thread plans wait for a new topic receipt; web-silent children run in the background and return to the parent; The saved admission notices queue the task summaries and actual links to the source topic; do not repeat them. Queue admission is not delivery or task completion.'
        : 'Draft only; no Session created. Offer the proposal asynchronously and continue already authorized work in the source Session without waiting. Before a later approval, reconcile source progress so completed or active work is not duplicated.' };
    }
    let plan = plans(source).find(p => p.id === body.planId);
    if (!plan || plan.actor.personId !== actor.personId) fail('Select this requester’s plan in this source conversation');
    if (body.action === 'approve') {
      if (plan.approvalRequestId === record.requestId) {
        if (JSON.stringify(plan.selected) !== JSON.stringify(body.selected)) fail('Retry must preserve selected branches');
        followUps.push(() => advancePlan(source.id, plan.id, deps));
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
      followUps.push(() => advancePlan(source.id, plan.id, deps));
    } else if (body.action === 'answer') {
      const b = plan.branches.find(b => b.id === body.branchId);
      if (!b || b.state !== 'running' || b.stopRequested) fail('Select a running branch with a pending question');
      const child = await requests.byRequest(b.sessionId, b.requestId);
      const question = child && await readNativeQuestion(runDir(child.nativeDispatchRunId || child.runId));
      if (question?.state !== 'pending' || question.id !== body.questionId || !clean(body.text, 3000)) fail('Question changed; read the pending question before relaying the human answer');
      const requestId = 'plan-answer:' + hash(record.requestId + ':' + question.id);
      const api = await manager(deps);
      const prior = await requests.byRequest(b.sessionId, requestId);
      followUps.push(async () => {
        const receipt = await api.submitHttpMessage(b.sessionId, prior?.text || body.text, [], prior?.options || {
          requestId, nativeQuestionId: question.id, viewPersonId: actor.personId, initiatedByIdentityId: actor.identityId,
          recordUserMessage: false, suppressSourceDelivery: plan.branchSurface !== 'feishu-thread', ...plan.runtimeSelection,
          workPlanChild: { sourceSessionId: source.id, planId: plan.id, branchId: b.id },
          sourceContext: { connector: 'work-plan-answer', sourceSessionId: source.id, sourceRequestId: record.requestId },
        });
        await appendEvent(source.id, { type: 'work_event', action: 'execution-question-answered', planId: plan.id,
          branchId: b.id, sourceRequestId: record.requestId, targetRequestId: receipt.requestId, questionId: question.id });

      });
    } else if (['stop', 'amend', 'continue'].includes(body.action)) {
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
          fail('Use continue for a human-authorized follow-up in an ended branch; stopped work cannot restart');
        }
        if (body.action === 'continue' && (['draft', 'cancelled', 'stopping', 'reviewing'].includes(plan.state)
            || selected.some(id => { const b = plan.branches.find(b => b.id === id);
              return !['completed', 'failed'].includes(b.state) || b.stopRequested || !b.sessionId; }))) {
          fail('Continue needs an ended, non-stopped branch and no active parent review');
        }
        await save(source.id, data => {
          const p = data.executionPlans.find(p => p.id === plan.id);
          p.controls.push({ id, requestId: record.requestId, action: body.action, selected, text,
            actor, state: 'pending', at: new Date().toISOString() });
          p.version++;
          if (body.action === 'continue') {
            p.state = 'running';
            p.reviewRound = (p.reviewRound || 0) + 1;
            delete p.reviewRunId; delete p.reviewRequestId;
            for (const b of p.branches) if (selected.includes(b.id)) {
              b.previousResults ||= [];
              b.previousResults.push({ requestId: b.requestId, state: b.state, result: b.result, completedAt: b.completedAt });
              b.state = 'running'; b.requestId = id + ':' + b.id;
              delete b.result; delete b.error; delete b.completedAt;
            }
          }
          if (body.action === 'stop') for (const b of p.branches) if (selected.includes(b.id)) {
            b.stopRequested = true;
            if (b.state === 'pending') b.state = 'cancelled';
          }
          if (body.action === 'stop' && p.branches.every(b => b.stopRequested || b.state === 'skipped')) p.state = 'stopping';
        });
      }
      if (body.action === 'stop' && plan.reviewRunId) {
        const api = await manager(deps);
        followUps.push(() => api.cancelActiveRun(source.id, { expectedRunId: plan.reviewRunId }));
      }
      followUps.push(() => applyControls(source.id, plan.id, deps));
      followUps.push(() => {
        const advancing = advancePlan(source.id, plan.id, deps);
        if (body.action !== 'stop') return advancing;
        // Stop is durably accepted even if an earlier child creation is slow.
        void advancing.catch(error => console.error(`[work-plan] ${plan.id}: ${error.message}`));
      });
    } else if (body.action === 'resume') {
      followUps.push(() => applyControls(source.id, plan.id, deps));
      followUps.push(() => advancePlan(source.id, plan.id, deps));
    } else fail('Use propose, start, approve, record, amend, continue, answer, stop or resume');
    return { plan: plans(await findSessionMeta(source.id)).find(p => p.id === plan.id) };
  });
  // Admission/decisions have committed. External work cannot hold the command queue.
  await Promise.all(followUps.map(operation => operation()));
  if (result?.plan) return { ...result,
    plan: plans(await findSessionMeta(result.plan.sourceSessionId)).find(p => p.id === result.plan.id) };
  return result;
}

async function applyControls(sourceId, planId, deps) {
  let plan = plans(await findSessionMeta(sourceId)).find(p => p.id === planId);
  const api = await manager(deps);
  for (const control of plan.controls.filter(c => c.state === 'pending')) {
    for (const id of control.selected) {
      const b = plan.branches.find(b => b.id === id);
      if (control.action === 'stop' && b.topicDeliveryId && !b.runId) {
        const opening = await getSourceDelivery(b.topicDeliveryId);
        if (opening?.state === 'pending') await resolveSourceDelivery(opening.id, { state: 'cancelled', reason: 'Branch stopped before topic publication' });
      }
      if (!b.sessionId || !b.runId || terminal(b.state)) continue;
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
        await save(sourceId, data => {
          data.executionPlans.find(p => p.id === planId).branches.find(b => b.id === id).requestId = requestId;
        });
        const receipt = await api.submitHttpMessage(b.sessionId, old?.text || `主话题中人的补充（来源 ${sourceId}，输入 ${control.requestId}）：\n${control.text}\n在当前子Session接续原工作，不再创建分支。保持原任务及范围，说明这次补充怎样影响结果。`, [], old?.options || {
          requestId, ...plan.runtimeSelection, viewPersonId: control.actor.personId,
          initiatedByIdentityId: control.actor.identityId, recordUserMessage: false,
          workPlanChild: { sourceSessionId: sourceId, planId, branchId: b.id },
          suppressSourceDelivery: plan.branchSurface !== 'feishu-thread', sourceContext: { connector: 'work-plan', sourceSessionId: sourceId },
        });
        await save(sourceId, data => {
          const branch = data.executionPlans.find(p => p.id === planId).branches.find(b => b.id === id);
          branch.runId = receipt.run.id;
        });
      }
    }
    await save(sourceId, data => { data.executionPlans.find(p => p.id === planId).controls.find(c => c.id === control.id).state = 'submitted'; });
    plan = plans(await findSessionMeta(sourceId)).find(p => p.id === planId);
  }
}

// Reuse the durable one-branch workflow after the native kickoff decision.
// Callers supply only a persisted proposal ID, never an approval payload.
export async function startConfirmedWorkKickoff(sourceId, proposalId, deps) {
  const id = 'plan_' + hash('kickoff:' + proposalId);
  await serial(sourceId, async () => {
    const source = await findSessionMeta(sourceId);
    if (plans(source).some(p => p.id === id)) return;
    const { validateWorkKickoffPlan } = await import('./work-kickoff.mjs');
    const p = await validateWorkKickoffPlan(sourceId, proposalId);
    const context = `已定方案与范围：${p.plan}\n来源：${p.sources}\n未决项：${p.unresolved}\n验收：${p.acceptance}`;
    const plan = { id, state: 'approved', version: 1, goal: p.goal, context,
      reason: '原生问题卡中的人类开工确认', actor: p.actor, sourceSessionId: sourceId,
      sourceRequestId: p.sourceRequestId, approvalRequestId: p.decisionRequestId,
      approval: p.choice, selected: ['work'], executionMode: 'single-session',
      workKickoff: { sourceSessionId: sourceId, proposalId }, createdAt: new Date().toISOString(),
      runtimeSelection: p.runtimeSelection, folder: p.folder, returnPlan: p.origin, controls: [],
      branchSurface: 'feishu-thread', branchOrigin: p.target,
      branches: [{ id: 'work', name: p.goal.slice(0, 100), task: context,
        writeScope: p.plan, dependsOn: [], state: 'pending' }] };
    await save(sourceId, data => data.executionPlans.push(plan));
  });
  await advancePlan(sourceId, id, deps);
  return plans(await findSessionMeta(sourceId)).find(p => p.id === id);
}
async function validateKickoff(plan) {
  if (!plan?.workKickoff) return;
  const { validateWorkKickoffPlan } = await import('./work-kickoff.mjs');
  await validateWorkKickoffPlan(plan.workKickoff.sourceSessionId, plan.workKickoff.proposalId);
}
// Outbox claim checks the original discussion's epoch as well as the work
// group's own participation gate. A pending opening cannot escape a mode change.
export async function validateExecutionPlanTopic(delivery) {
  if (!delivery?.responseId?.startsWith('plan-topic:')) return;
  const child = await findSessionMeta(delivery.sessionId);
  const source = child?.delegatedFromSessionId && await findSessionMeta(child.delegatedFromSessionId);
  const plan = plans(source).find(p => p.id === delivery.responseId.split(':')[1]);
  await validateKickoff(plan);
}

async function publishPlanAdmissions(sourceId, planId) {
  let plan = plans(await findSessionMeta(sourceId)).find(p => p.id === planId);
  if (!plan || plan.state === 'stopping') return;
  const admitted = plan.branches.filter(b => b.sessionId && b.runId && !b.admissionNoticeId && !b.stopRequested);
  if (admitted.length) {
    const id = 'plan-admission:' + hash(plan.id + ':' + admitted.map(b => b.id).join(','));
    const text = ['已创建并提交以下独立子 Session：', '', ...admitted.map(b =>
      `- ${b.topicUrl ? `[${b.name}](${b.topicUrl})` : plan.branchSurface === 'feishu-thread' ? `${b.name}（已在当前群创建话题，飞书尚未返回话题链接）` : `[${b.name}](${b.sessionUrl})`}：${clipCompactionSection(b.task, 240).replace(/\s+/g, ' ').trim()}`),
      '', plan.branchSurface === 'feishu-thread'
        ? '各独立话题承接对应工作；主话题负责协调、核验和汇总。'
        : '子工作在网页后台执行；请继续在本话题补充和回答问题，由主话题协调、核验和汇总。网页链接用于查看执行记录。'].join('\n');
    // Freeze the batch before enqueue: retries cannot regroup it or duplicate it.
    await save(sourceId, data => {
      const p = data.executionPlans.find(p => p.id === planId);
      p.admissionNotices ||= [];
      p.admissionNotices.push({ id, text });
      for (const b of p.branches) if (admitted.some(a => a.id === b.id)) b.admissionNoticeId = id;
    });
  }
  plan = plans(await findSessionMeta(sourceId)).find(p => p.id === planId);
  for (const notice of plan.admissionNotices || []) {
    if (notice.deliveryId) continue;
    const delivery = await enqueueSourceDelivery({ sessionId: sourceId, responseId: notice.id,
      sourceDelivery: plan.returnPlan, text: notice.text });
    await save(sourceId, data => {
      data.executionPlans.find(p => p.id === planId).admissionNotices.find(n => n.id === notice.id).deliveryId = delivery.id;
    });
  }
}

const planAdvances = createKeyedTaskQueue();
function advancePlan(sourceId, planId, deps) {
  return planAdvances(sourceId + ':' + planId, () => advancePlanUnlocked(sourceId, planId, deps));
}

async function advancePlanUnlocked(sourceId, planId, deps) {
  let source = await findSessionMeta(sourceId), plan = plans(source).find(p => p.id === planId);
  if (!plan || !['approved', 'running', 'stopping'].includes(plan.state) || source.archived) return;
  const api = await manager(deps);
  // Stable Session and Request keys make partial admission recoverable on restart.
  for (const initialBranch of plan.branches) {
    plan = plans(await findSessionMeta(sourceId)).find(p => p.id === planId);
    const branch = plan.branches.find(b => b.id === initialBranch.id);
    if (branch.state !== 'pending' || branch.stopRequested || plan.state === 'stopping') continue;
    await validateKickoff(plan);
    const dependencies = branch.dependsOn.map(id => plan.branches.find(b => b.id === id));
    if (dependencies.some(b => terminal(b.state) && b.state !== 'completed')) {
      await save(sourceId, data => { data.executionPlans.find(p => p.id === planId).branches.find(b => b.id === branch.id).state = 'blocked'; });
      branch.state = 'blocked'; continue;
    }
    if (dependencies.some(b => b.state !== 'completed')) continue;
    let target = branch.sessionId ? await findSessionMeta(branch.sessionId) : await api.createSession(plan.folder,
      plan.runtimeSelection?.tool || source.tool, branch.name, { ...plan.runtimeSelection,
        sourceId: plan.branchSurface === 'feishu-thread' ? 'feishu' : 'chat',
        ...(plan.branchSurface === 'feishu-thread' ? { conversation: plan.branchOrigin } : {}), initiatedByIdentityId: plan.actor.identityId, viewPersonId: plan.actor.personId,
        delegatedFromSessionId: sourceId, delegationDepth: (source.delegationDepth || 0) + 1,
        externalTriggerId: 'work-plan:' + plan.id + ':' + branch.id });
    if (!target || target.archived) fail('The planned child Session is unavailable');
    const requestId = 'work-plan:' + plan.id + ':' + branch.id;
    await save(sourceId, data => { Object.assign(data.executionPlans.find(p => p.id === planId).branches.find(b => b.id === branch.id), {
      sessionId: target.id, sessionUrl: buildSessionNavigationHref(target.id), requestId }); });
    plan = plans(await findSessionMeta(sourceId)).find(p => p.id === planId);
    if (['stopping', 'cancelled'].includes(plan.state) || plan.branches.find(b => b.id === branch.id).stopRequested) continue;
    await validateKickoff(plan);
    if (plan.branchSurface === 'feishu-thread') {
      // The unanchored opening is durable and idempotent. Never fall back to a
      // Web-only execution when the group send is pending or uncertain.
      const delivery = branch.topicDeliveryId ? await getSourceDelivery(branch.topicDeliveryId)
        : await enqueueSourceDelivery({ sessionId: target.id, responseId: `plan-topic:${plan.id}:${branch.id}`,
          sourceDelivery: plan.branchOrigin,
          text: `${branch.name}\n\n${branch.task}\n\n本话题承接这项分工，可在这里补充要求。原话题负责协调和汇总。` });
      await save(sourceId, data => { data.executionPlans.find(p => p.id === planId).branches.find(b => b.id === branch.id).topicDeliveryId = delivery.id; });
      plan = plans(await findSessionMeta(sourceId)).find(p => p.id === planId);
      if (['stopping', 'cancelled'].includes(plan.state) || plan.branches.find(b => b.id === branch.id).stopRequested) {
        const opening = await getSourceDelivery(delivery.id);
        if (opening?.state === 'pending') await resolveSourceDelivery(opening.id, { state: 'cancelled', reason: 'Branch stopped during topic admission' });
        continue;
      }
      if (delivery.state !== 'delivered') continue;
      target = await findSessionMeta(target.id);
      if (!target.conversation?.target?.rootId) fail('Topic receipt has not bound the child Session');
      const hasThread = target.conversation.target.threadId || target.conversation.target.topicId?.startsWith('omt_');
      await save(sourceId, data => {
        data.executionPlans.find(p => p.id === planId).branches.find(b => b.id === branch.id).topicUrl = hasThread ? groupWorkHref(target.conversation, target.id) : '';
      });
    }
    plan = plans(await findSessionMeta(sourceId)).find(p => p.id === planId);
    if (plan.state === 'stopping' || plan.state === 'cancelled' || plan.branches.find(b => b.id === branch.id).stopRequested) continue;
    await validateKickoff(plan);
    const amendments = plan.controls.filter(c => c.action === 'amend' && c.selected.includes(branch.id)).map(c => c.text).join('\n');
    const text = `经人确认的独立分工。主话题：${sourceId}；方案：${plan.id}；分支：${branch.id}。\n总目标：${plan.goal}\n已确定的背景、约束和来源：\n${plan.context}\n你的任务：${branch.task}\n修改范围：${branch.writeScope}\n${amendments ? '人的后续补充：\n' + amendments : ''}\n${dependencies.length ? '前置结果（需按原证据核对）：\n' + dependencies.map(b => `${b.name} (${b.sessionId}): ${b.result}`).join('\n') : ''}\n仅执行这份分工。不要递归拆分、向其他群发消息或扩大授权。最终返回成果、证据、未解决问题，系统负责回到主话题。需要人补充时使用原生提问，主话题可查到等待状态，不能替人确认。`;
    const prior = await requests.byRequest(target.id, requestId);
    const receipt = await api.submitHttpMessage(target.id, prior?.text || text, [], prior?.options || {
      requestId, ...plan.runtimeSelection, viewPersonId: plan.actor.personId, initiatedByIdentityId: plan.actor.identityId,
      recordUserMessage: false, suppressSourceDelivery: plan.branchSurface !== 'feishu-thread',
      ...(plan.branchSurface === 'feishu-thread' ? { sourceDelivery: target.conversation } : {}),
      workPlanChild: { sourceSessionId: sourceId, planId, branchId: branch.id },
      sourceContext: { connector: 'work-plan', sourceSessionId: sourceId },
    });
    await save(sourceId, data => {
      const p = data.executionPlans.find(p => p.id === planId);
      const b = p.branches.find(b => b.id === branch.id);
      if (!b.stopRequested && b.state === 'pending') {
        if (p.state === 'approved') p.state = 'running';
        b.state = 'running';
      }
      b.runId = receipt.run.id;
    });
    const latest = plans(await findSessionMeta(sourceId)).find(p => p.id === planId);
    if (latest.branches.find(b => b.id === branch.id).stopRequested) await api.cancelActiveRun(target.id, { expectedRunId: receipt.run.id });
  }
  await publishPlanAdmissions(sourceId, planId);
  source = await findSessionMeta(sourceId); plan = plans(source).find(p => p.id === planId);
  if (!plan.branches.every(b => terminal(b.state))) return;
  if (plan.state === 'stopping' || plan.branches.every(b => ['cancelled', 'skipped'].includes(b.state))) {
    await save(sourceId, data => { data.executionPlans.find(p => p.id === planId).state = 'cancelled'; });
    return; // A stop cannot wake the parent or restart its work.
  }
  const requestId = 'work-plan-review:' + plan.id + (plan.reviewRound ? ':' + plan.reviewRound : '');
  const text = `已确认方案 ${plan.id} 的选定分支已结束，请在主话题核验并汇总。\n原目标：${plan.goal}\n原范围与来源：${plan.context}\n${plan.branches.filter(b => b.state !== 'skipped').map(b => `${b.name} (${b.id}, Session ${b.sessionId || '未启动'})：${b.state}\n${b.result || b.error || '没有成果；不能认定完成。'}`).join('\n\n')}\n这次只核验和整合已有成果，回复原交办者。执行结束不等于业务验收；缺口、冲突和失败必须说明。不要自行重新开工、恢复停止分支或发布到其他群；人的后续决定优先。`;
  const prior = await requests.byRequest(sourceId, requestId);
  const receipt = await api.submitHttpMessage(sourceId, prior?.text || text, [], prior?.options || {
    requestId, ...plan.runtimeSelection, viewPersonId: plan.actor.personId, initiatedByIdentityId: plan.actor.identityId,
    allowGroupFeedWrite: true, recordUserMessage: false, workPlanReview: { sourceSessionId: sourceId, planId },
    sourceContext: { connector: 'work-plan-review', sourceSessionId: sourceId }, sourceDelivery: plan.returnPlan,
  });
  await save(sourceId, data => {
    const current = data.executionPlans.find(p => p.id === planId);
    current.reviewRequestId = requestId;
    current.reviewRunId = receipt.run.id;
    if (['approved', 'running'].includes(current.state)) current.state = 'reviewing';
  });
  const latest = plans(await findSessionMeta(sourceId)).find(p => p.id === planId);
  if (['stopping', 'cancelled'].includes(latest.state)) {
    await api.cancelActiveRun(sourceId, { expectedRunId: receipt.run.id });
  }
}

export async function completeExecutionPlan(record, run, deps) {
  if (!record?.options?.workPlanChild && !record?.options?.workPlanReview) return;
  return serial((record.options.workPlanChild || record.options.workPlanReview).sourceSessionId, async () => {
    const ref = record.options.workPlanChild || record.options.workPlanReview;
    const source = await findSessionMeta(ref.sourceSessionId);
    const plan = plans(source).find(p => p.id === ref.planId);
    if (!plan) return;
    if (record.options.workPlanReview) {
      if (['cancelled', 'stopping'].includes(plan.state)) return;
      if (record.requestId !== 'work-plan-review:' + plan.id + (plan.reviewRound ? ':' + plan.reviewRound : '')) return;
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
    return { sourceId: source.id, planId: plan.id };
  }).then(next => next && advancePlan(next.sourceId, next.planId, deps));
}

export async function validateExecutionPlanRequest(record) {
  const ref = record.options?.workPlanChild || record.options?.workPlanReview;
  if (!ref) return;
  const source = await findSessionMeta(ref.sourceSessionId);
  const p = plans(source).find(p => p.id === ref.planId);
  if (!p || source.archived || ['cancelled', 'stopping', 'draft'].includes(p.state)) fail('Execution plan is no longer active; do not restart cancelled work');
  // A completed result still returns to its owner after a participation change.
  if (record.options.workPlanChild) await validateKickoff(p);
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
      await applyControls(source.id, plan.id, deps);
      const current = plans(await findSessionMeta(source.id)).find(p => p.id === plan.id);
      for (const branch of current.branches) if (branch.sessionId && branch.requestId) {
        const record = await requests.byRequest(branch.sessionId, branch.requestId);
        if (record?.result) await completeExecutionPlan(record, { id: record.runId }, deps);
      }
      await applyControls(source.id, plan.id, deps);
      await advancePlan(source.id, plan.id, deps);
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
  if (!b || b.stopRequested || source.archived || p.branchSurface === 'feishu-thread') return;
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

export async function resumeExecutionPlanTopic(delivery, deps) {
  if (!delivery?.responseId?.startsWith('plan-topic:') || !['delivered', 'unknown', 'delivery_failed'].includes(delivery.state)) return;
  const child = await findSessionMeta(delivery.sessionId);
  if (!child?.delegatedFromSessionId) return;
  const [, planId, branchId] = delivery.responseId.split(':');
  const followUp = await serial(child.delegatedFromSessionId, async () => {
    const source = await findSessionMeta(child.delegatedFromSessionId);
    const p = plans(source).find(p => p.id === planId);
    const b = p?.branches.find(b => b.id === branchId);
    if (!source || source.archived || p?.branchSurface !== 'feishu-thread' || b?.sessionId !== child.id
        || b.topicDeliveryId !== delivery.id || b.stopRequested) return;
    if (delivery.state !== 'delivered') {
      return () => enqueueSourceDelivery({ sessionId: source.id,
        responseId: `plan-topic-issue:${p.id}:${b.id}:${delivery.state}:${delivery.attempts}`,
        sourceDelivery: p.returnPlan,
        text: `分支「${b.name}」的飞书话题${delivery.state === 'unknown' ? '尚无法确认是否送达' : '创建失败'}，尚未启动执行。原因：${delivery.lastError || '请核对投递状态'}。原分支已保留，核实回执后可接续。` });
    }
    return () => advancePlan(source.id, p.id, deps);
  });
  return followUp?.();
}
