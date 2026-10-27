import { readFile } from 'node:fs/promises';
import { createRemoteLabHttpClient } from '../../lib/remotelab-http-client.mjs';

const client = createRemoteLabHttpClient();
export async function nativeApi(path, body) {
  const r = await client.request(path, { ...(body ? { method: 'POST', body } : {}),
    headers: process.env.REMOTELAB_TRIAL_SOURCE_SESSION ? { 'x-remotelab-source-session-id': process.env.REMOTELAB_TRIAL_SOURCE_SESSION } : {},
    signal: AbortSignal.timeout(12000) });
  if (!r.response.ok) throw new Error(r.json?.error || `执行接口返回 ${r.response.status}`);
  return r.json;
}
export const runtime = {
  async session(task, cycle, workspace) {
    const { session } = await nativeApi('/api/sessions', {
      folder: workspace, tool: cycle.definition.runtime.tool, name: `试用 · ${cycle.definition.title}`,
      ...cycle.definition.runtime, group: '自动化试用', sessionCollection: 'automations',
      externalTriggerId: `automation-trial:${task.id}:${cycle.id}`,
      description: `独立试用任务 ${task.id}；仅本任务范围生效`,
    });
    return session.id;
  },
  async submit(sessionId, prompt, requestId) {
    return (await nativeApi(`/api/sessions/${sessionId}/messages`, { text: prompt, requestId,
      suppressSourceDelivery: true })).run;
  },
  async run(id) { return (await nativeApi(`/api/runs/${id}`)).run; },
  async receipt(path) { return JSON.parse(await readFile(path, 'utf8')); },
  async deliver(task, cycle, type, requestId) {
    const text = type === 'result' ? cycle.result.output : `【需要处理】${cycle.definition.title}\n${cycle.error}`;
    if (type === 'result' && cycle.definition.recipient.kind === 'agent') {
      const target = cycle.definition.recipient.sessionId;
      if (target === cycle.sessionId) throw new Error('不能将结果再交给本轮执行会话');
      const r = await nativeApi(`/api/sessions/${target}/messages`, {
        text: `来自自动化任务「${cycle.definition.title}」的结果：\n${text}`, requestId, suppressSourceDelivery: true,
      });
      return { channel: 'agent', sessionId: target, requestId: r.requestId, runId: r.run.id,
        detail: '接收 Agent 已接纳，后续处理见其会话' };
    }
    if (!cycle.sessionId) cycle.sessionId = await runtime.session(task, cycle, (await import('./store.mjs')).store.root);
    const { events } = await nativeApi(`/api/sessions/${cycle.sessionId}/events?filter=all`);
    let event = events.find(e => e.requestId === requestId && e.source === 'automation_trial');
    if (!event) event = (await nativeApi(`/api/sessions/${cycle.sessionId}/assistant-messages`, {
      text, source: 'automation_trial', requestId,
    })).event;
    return { channel: 'web', sessionId: cycle.sessionId, eventId: event.id, detail: '已写入本页与任务会话，未发送飞书消息' };
  },
};
