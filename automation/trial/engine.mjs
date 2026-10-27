import { join } from 'node:path';
import { newCycle, canStart, nextDue, taskPrompt } from './model.mjs';

// The store and runtime are injected so scenarios never touch live instance data.
export function createEngine(store, runtime, { clock = Date.now } = {}) {
  const event = (t, text) => { t.updatedAt = new Date(clock()).toISOString(); t.events.push({ at: t.updatedAt, text }); };
  const save = t => store.save(t);
  async function notify(t, c, type) {
    if (c.deliveries[type]?.state === 'delivered') return;
    const id = `trial:${t.id}:${c.id}:${type}:${c.interventions || 0}`;
    c.deliveries[type] = { state: 'sending', requestId: id }; await save(t);
    try {
      const receipt = await runtime.deliver(t, c, type, id);
      c.deliveries[type] = { state: 'delivered', at: new Date(clock()).toISOString(), ...receipt };
      event(t, type === 'result' ? '结果已交付到所选入口' : '处理请求已写入负责人的任务会话');
    } catch (error) {
      c.deliveries[type] = { state: 'failed', requestId: id, error: error.message };
      if (type === 'result') c.status = 'delivery_failed';
      event(t, `通知失败：${error.message}`);
    }
    await save(t);
  }
  async function human(t, c, reason) {
    c.status = 'needs_human'; c.error = reason;
    event(t, `需要人处理：${reason}`); await save(t); await notify(t, c, 'human');
  }
  async function failed(t, c, error) {
    c.error = error;
    if (c.attempts.length - (c.repairBase || 0) >= 3) return human(t, c, `两轮修复未解决：${error}`);
    c.status = 'queued'; event(t, `发现异常，进入 Agent 诊断修复：${error}`); await save(t);
  }
  async function advance(t) {
    const c = t.cycles.at(-1);
    if (!c || ['stopped', 'delivery_failed'].includes(c.status)) return;
    if (c.status === 'completed' || c.status === 'needs_human') {
      const type = c.status === 'completed' ? 'result' : 'human';
      if (!c.deliveries[type] || c.deliveries[type].state === 'sending') await notify(t, c, type);
      return;
    }
    if (c.status === 'queued' || c.status === 'admitting') {
      if (t.state !== 'active') return;
      let a = c.attempts.at(-1);
      if (c.status === 'queued') {
        a = { number: c.attempts.length + 1, requestId: `trial:${t.id}:${c.id}:attempt:${c.attempts.length + 1}`, admittedAt: new Date(clock()).toISOString() };
        c.attempts.push(a); c.status = 'admitting'; await save(t);
      }
      if (a.retryAt && Date.parse(a.retryAt) > clock()) return;
      try {
        const workspace = await store.workspace(t.id, c.id);
        a.receiptPath = join(workspace, `result-${a.number}.json`);
        if (!c.sessionId) { c.sessionId = await runtime.session(t, c, workspace); await save(t); }
        const run = await runtime.submit(c.sessionId, taskPrompt(t, c, a.receiptPath, workspace), a.requestId, t);
        a.runId = run.id; c.status = a.number === 1 ? 'running' : 'repairing';
        event(t, a.number === 1 ? '执行已启动' : `第 ${a.number - 1} 轮 Agent 修复已启动`); await save(t);
      } catch (error) {
        a.admissionFailures = (a.admissionFailures || 0) + 1;
        if (a.admissionFailures <= 2) {
          // Reuse the same native request ID after a lost acknowledgement.
          a.retryAt = new Date(clock() + (a.admissionFailures === 1 ? 30_000 : 120_000)).toISOString();
          event(t, `执行通路暂不可用，将核对同一请求：${error.message}`); await save(t);
        } else await human(t, c, `Agent 未能启动，需处理执行通路：${error.message}`);
      }
      return;
    }
    const a = c.attempts.at(-1); let run;
    try { run = await runtime.run(a.runId); }
    catch (error) {
      if (c.observationError !== error.message) { c.observationError = error.message; event(t, `监管暂不可用，保留原运行：${error.message}`); await save(t); }
      return;
    }
    if (c.observationError) { delete c.observationError; event(t, '执行状态读取已恢复'); await save(t); }
    if (!run) return human(t, c, '运行记录不可读取，需要恢复执行记录');
    if (!['completed', 'failed', 'cancelled'].includes(run.state)) {
      const minutes = c.definition.monitoring.noProgressMinutes;
      if (minutes && clock() - Date.parse(run.lastNormalizedAt || run.updatedAt || a.admittedAt) > minutes * 60_000 && !c.stallNotified) {
        c.stallNotified = true; c.error = `超过 ${minutes} 分钟无新执行事件；运行仍保留，请查看执行会话`;
        event(t, c.error); await save(t); await notify(t, c, 'stall');
      }
      return;
    }
    a.completedAt = new Date(clock()).toISOString(); a.state = run.state;
    if (run.state !== 'completed') return failed(t, c, run.failureReason || run.result?.error || `执行${run.state}`);
    let receipt;
    try { receipt = await runtime.receipt(a.receiptPath); } catch (e) { return failed(t, c, `结果交接不可读：${e.message}`); }
    if (!receipt || !['completed', 'needs_human', 'failed'].includes(receipt.status) || !String(receipt.summary || '').trim()) return failed(t, c, '执行结束但没有有效的任务结果');
    c.result = receipt;
    if (receipt.status === 'needs_human') return human(t, c, receipt.humanAction || receipt.summary);
    if (receipt.status === 'failed' || !String(receipt.output || '').trim()) return failed(t, c, receipt.summary || '缺少约定输出');
    c.status = 'completed'; c.completedAt = new Date(clock()).toISOString();
    event(t, '已收到任务结果'); await save(t); await notify(t, c, 'result');
  }
  async function tickTask(id) {
    return store.serial(id, async () => {
      const t = await store.read(id); if (!t) return;
      if (t.state === 'active' && t.definition.endsAt && Date.parse(t.definition.endsAt) <= clock()) {
        t.state = 'ended'; event(t, '生效期结束，停止后续触发；在途结果继续接收'); await save(t);
      }
      if (t.nextAt && Date.parse(t.nextAt) <= clock() && canStart(t, clock())) {
        t.cycles.push(newCycle(t, clock()));
        t.nextAt = t.definition.schedule.kind === 'once' ? '' : nextDue(t.definition, clock());
        event(t, '到达约定时间'); await save(t);
      }
      await advance(t);
    });
  }
  return {
    async tick() { return Promise.allSettled((await store.list()).map(t => tickTask(t.id))); }, tickTask,
    async action(id, action, input = {}) {
      const result = await store.serial(id, async () => {
        const t = await store.read(id); if (!t) throw new Error('任务不存在');
        const c = t.cycles.at(-1);
        if (action === 'run') {
          if (!canStart(t, clock())) throw new Error('任务尚未生效、已暂停或仍有未处理的运行');
          t.cycles.push(newCycle(t, clock())); event(t, '手动开始本轮');
        } else if (action === 'pause') { t.state = 'paused'; event(t, '暂停后续触发；在途运行继续'); }
        else if (action === 'resume') { t.state = 'active'; event(t, '恢复后续触发'); }
        else if (action === 'continue') {
          if (!c || c.status !== 'needs_human') throw new Error('当前没有等待处理的问题');
          if (!String(input.answer || '').trim()) throw new Error('请填写补充信息或已完成的操作');
          c.definition.sop += `\n负责人补充：${input.answer}`;
          c.error += `；负责人补充：${input.answer}`; c.status = 'queued';
          // A human intervention is a new repair opportunity, not a new occurrence.
          c.repairBase = c.attempts.length; c.interventions = (c.interventions || 0) + 1;
          delete c.deliveries.human;
          event(t, '收到补充，沿原问题继续处理');
        } else if (action === 'deliver') {
          if (!c || !['delivery_failed', 'needs_human'].includes(c.status)) throw new Error('当前没有待补的通知');
          if (c.status === 'delivery_failed') c.status = 'completed';
          await notify(t, c, c.status === 'needs_human' ? 'human' : 'result');
        } else throw new Error('不支持的操作');
        return save(t);
      });
      return result;
    },
  };
}
