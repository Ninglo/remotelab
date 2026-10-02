import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { canonicalJson } from '../../lib/durable-records.mjs';

export const projectDigest = value => createHash('sha256').update(typeof value === 'string'
  ? value : canonicalJson(value)).digest('hex').slice(0, 24);
const trim = value => typeof value === 'string' ? value.trim() : '';

// This registry contains source pointers, never a second copy of project memory
// or scheduler state. Only the local operator can register sources.
export async function loadProjectSources(runtime, chatId) {
  const link = runtime.config.projectLinks?.find(entry =>
    [entry.discussionChatId, entry.workChatId].includes(chatId));
  if (!link || !runtime.config.projectSurfacesPath) throw new Error('当前群尚未启用项目入口。');
  const raw = JSON.parse(await readFile(runtime.config.projectSurfacesPath, 'utf8'));
  const source = raw?.projects?.[link.projectId];
  if (raw.schema !== 1 || !source || !trim(source.name)
    || !isAbsolute(trim(source.memory?.path)) || !/^#{1,6} .+/.test(trim(source.memory?.heading))) {
    throw new Error('项目来源登记不完整，请修复登记后再使用。');
  }
  const tasks = source.tasks || [];
  if (!Array.isArray(tasks) || tasks.length > 10 || tasks.some(task =>
    !/^sch_[a-f0-9]{24}$/.test(task.id) || !/^[a-z][a-z0-9-]{0,39}$/.test(task.alias)
    || !trim(task.scope)) || new Set(tasks.map(task => task.alias)).size !== tasks.length
    || new Set(tasks.map(task => task.id)).size !== tasks.length) {
    throw new Error('项目自动任务登记无效。');
  }
  const resources = source.resources || [];
  if (!Array.isArray(resources) || resources.length > 20 || resources.some(resource =>
    !trim(resource.name) || trim(resource.name).length > 100 || trim(resource.url).length > 500
    || !/^https:\/\/[^\s<>]+$/.test(trim(resource.url)))) {
    throw new Error('项目关联资料登记无效。');
  }
  return { ...source, link, tasks, resources, bindingVersion: projectDigest({ source, link }) };
}

export function projectMemorySection(text, heading) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const matches = lines.flatMap((line, index) => line === heading ? [index] : []);
  if (matches.length !== 1) throw new Error('项目记忆标题缺失或重复，不能确定来源范围。');
  const start = matches[0];
  const level = heading.match(/^#+/)[0].length;
  const relativeEnd = lines.slice(start + 1).findIndex(line => {
    const match = line.match(/^(#{1,6}) /);
    return match && match[1].length <= level;
  });
  const end = relativeEnd < 0 ? lines.length : start + 1 + relativeEnd;
  return lines.slice(start, end).join('\n').trim();
}

export function projectPages(text, limit = 3800) {
  const pages = [];
  let page = '';
  for (const paragraph of text.split(/\n\n/)) {
    if (page && page.length + paragraph.length + 2 > limit) { pages.push(page); page = ''; }
    let rest = paragraph;
    while (rest.length > limit) { pages.push(rest.slice(0, limit)); rest = rest.slice(limit); }
    page += `${page ? '\n\n' : ''}${rest}`;
  }
  if (page || !pages.length) pages.push(page);
  return pages;
}

export async function readProjectMemory(source) {
  const text = await readFile(source.memory.path, 'utf8');
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('记忆来源过大，请收窄项目来源。');
  const section = projectMemorySection(text, source.memory.heading);
  return { version: projectDigest(section), pages: projectPages(section), section };
}

export async function projectRequest(request, path, options) {
  const result = await request(path, options);
  if (!result.response?.ok) throw new Error('项目运行状态暂时无法核实。');
  return result.json;
}

export function taskVersion(task) {
  // Execution timestamps and scheduler counters must not invalidate a control
  // click. Changes to the actual configuration do invalidate it.
  const { type, cron, timezone, everySeconds } = task.schedule || {};
  return projectDigest({ id: task.id, state: task.state, enabled: task.enabled,
    title: task.title, prompt: task.prompt, schedule: { type, cron, timezone, everySeconds },
    lifetime: task.lifetime, gate: task.gate, target: task.target, runtime: task.runtime });
}

export async function readProjectTask(request, registration) {
  const { task } = await projectRequest(request, `/api/automation-tasks/${registration.id}`);
  if (!task || task.id !== registration.id) throw new Error('已登记的自动任务不存在。');
  return { ...registration, title: task.title, state: task.state, enabled: task.enabled,
    schedule: task.schedule, prompt: task.prompt, nextRunAt: task.nextRunAt,
    lastExecution: task.lastExecution, actions: task.actions || [], version: taskVersion(task) };
}

export async function readProjectView(runtime, chatId, request) {
  const source = await loadProjectSources(runtime, chatId);
  const results = await Promise.allSettled([readProjectMemory(source),
    ...source.tasks.map(task => readProjectTask(request, task))]);
  return { source, readAt: new Date().toISOString(),
    memory: results[0].status === 'fulfilled' ? results[0].value : { error: '记忆来源当前不可读；没有使用旧副本。' },
    tasks: results.slice(1).map((result, index) => result.status === 'fulfilled'
      ? result.value : { ...source.tasks[index], error: '当前状态不可核实，暂不提供修改。' }) };
}

export async function projectMemoryCorrection(runtime, summary, correction) {
  const source = await loadProjectSources(runtime, summary.chatId);
  const memory = await readProjectMemory(source);
  return `用户在飞书项目入口提出记忆修改，请在当前话题继续处理。\n`
    + `项目：${source.link.projectId}；唯一来源：${source.memory.path}\n`
    + `只修改标题“${source.memory.heading}”下的相关内容；读取时内容版本：${memory.version}。\n`
    + '先重新读取原记忆和最新讨论，核对修改依据及并发变化；保留来源、发言人、事实与提议的区别。'
    + '不要创建第二份项目记忆，不覆盖其他项目，不把用户提议自动写成组织共识。'
    + '如有冲突，在原话题解释并解决；写回后重新读取核验，回复实际采用的内容与范围。'
    + '项目卡片会直接读取同一来源。\n\n用户原文：\n' + correction;
}
