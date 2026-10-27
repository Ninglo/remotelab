import { readFile } from 'node:fs/promises';
import { store } from './store.mjs';
import { engine } from './service.mjs';
import { newTask, definition, nextDue } from './model.mjs';
import { readBody } from '../../lib/utils.mjs';
import { nativeApi } from './runtime.mjs';
const assets = new Map([['/automation-trial', ['index.html', 'text/html']], ['/automation-trial/', ['index.html', 'text/html']],
  ['/automation-trial/app.js', ['app.js', 'text/javascript']], ['/automation-trial/style.css', ['style.css', 'text/css']]]);
export async function handleTrialRoutes({ req, res, pathname, authSession, writeJson }) {
  if (assets.has(pathname) && req.method === 'GET') {
    const [file, type] = assets.get(pathname);
    const data = await readFile(new URL(`../../static/automation-trial/${file}`, import.meta.url));
    res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" });
    res.end(data); return true;
  }
  if (!pathname.startsWith('/api/automation-trial')) return false;
  try {
    if (req.method === 'GET' && pathname === '/api/automation-trial') {
      writeJson(res, 200, { tasks: (await store.list()).sort((a,b) => b.createdAt.localeCompare(a.createdAt)), actor: {
        personId: authSession.personId, personName: authSession.personName, identityId: authSession.identityId },
        boundary: '仅本入口新建任务生效。结果和人工预警写入本页与任务会话；此版不发送飞书消息。' }); return true;
    }
    if (req.method !== 'POST') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
    // JSON POST plus same-origin checks retain the existing login boundary.
    if (!String(req.headers['content-type'] || '').startsWith('application/json') || req.headers['sec-fetch-site'] === 'cross-site') {
      writeJson(res, 403, { error: '请从试用页面提交' }); return true;
    }
    const input = JSON.parse(await readBody(req, 131072) || '{}');
    const actor = { personId: authSession.personId, personName: authSession.personName, identityId: authSession.identityId };
    if (pathname === '/api/automation-trial') {
      const task = newTask(input, actor);
      if (task.definition.recipient.kind === 'agent') {
        if (!(await nativeApi(`/api/sessions/${task.definition.recipient.sessionId}?view=sidebar`)).session) throw new Error('接收会话不存在');
      }
      await store.save(task); writeJson(res, 201, { task }); return true;
    }
    const actionPath = pathname === '/api/automation-trial/action' ? `/api/automation-trial/${input.id}/${input.action}` : pathname;
    const match = /^\/api\/automation-trial\/(trial_[a-f0-9]{32})\/(run|pause|resume|continue|deliver|edit)$/.exec(actionPath);
    if (!match) { writeJson(res, 404, { error: 'Not found' }); return true; }
    const [, id, action] = match;
    let task;
    if (action === 'edit') task = await store.serial(id, async () => {
      const t = await store.read(id); if (!t) throw new Error('任务不存在');
      if (input.revision !== t.revision) throw new Error('任务已更新，请刷新后编辑');
      const d = definition(input.definition, actor);
      if (d.recipient.kind === 'agent' && !(await nativeApi(`/api/sessions/${d.recipient.sessionId}?view=sidebar`)).session) throw new Error('接收会话不存在');
      t.definition = d; t.revision++;
      t.nextAt = nextDue(t.definition, Date.now()); t.updatedAt = new Date().toISOString();
      t.events.push({ at: t.updatedAt, text: '任务定义已更新，下轮生效；本轮保留原定义' });
      return store.save(t);
    });
    else task = await engine.action(id, action, input);
    writeJson(res, 200, { task });
  } catch (e) { writeJson(res, 400, { error: e.message }); }
  return true;
}
