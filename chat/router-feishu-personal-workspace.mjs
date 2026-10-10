import { readBody, escapeHtml } from '../lib/utils.mjs';
import { authorizeFeishuWebSettings, connectFeishuWebSettings, disconnectFeishuWebSettings, feishuOrigin } from './feishu-web-settings.mjs';
import { personalWorkspace } from './feishu-personal-workspace.mjs';

const prefix = '/api/feishu-web-workspace/';
export const FEISHU_WORKSPACE_CONNECT_PATH = '/page/feishu-web-workspace/connect';
export async function handleFeishuPersonalWorkspace({ req, res, pathname, authSession, writeJson, nonce, workspace = personalWorkspace }) {
  if (!pathname.startsWith(prefix) && pathname !== FEISHU_WORKSPACE_CONNECT_PATH) return false;
  const url = new URL(req.url, 'http://localhost');
  try {
    if (pathname === FEISHU_WORKSPACE_CONNECT_PATH) {
      if (!authSession) return false;
      if (req.method !== 'GET') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
      const origin = feishuOrigin(url.searchParams.get('origin')), nativeAccount = url.searchParams.get('account'), state = url.searchParams.get('state');
      if (!/^\d{10,30}$/.test(nativeAccount || '') || !/^[a-f0-9]{32}$/.test(state || '') || authSession.authKind === 'service') throw Error('请从飞书入口重新连接本人的账号。');
      res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
      res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>连接 Index 与 thinking</title><style>body{font:16px/1.7 system-ui;margin:32px;max-width:440px;color:#1f2329}button{padding:10px 18px;background:#245bdb;color:white;border:0;border-radius:6px;cursor:pointer}small{color:#646a73}</style><h2>连接 Index 与 thinking</h2><p>当前登录：<strong>${escapeHtml(authSession.personName || '')}</strong></p><p>在飞书里继续你与 Index 的对话，查看本人的待办、已确认参与项目的日报，并在点击“开始分析”后生成建议。</p><p>只开放这些个人入口。不会自动修改待办、恢复暂停项目或向群聊发送分析。</p><small>请核对上面的姓名是你。连接按当前飞书浏览器账号保存；切换账号后需要分别连接。</small><p><button id="connect">连接这个账号</button></p><p id="status" role="status"></p><script nonce="${nonce}">
const origin=${JSON.stringify(origin)},nativeAccount=${JSON.stringify(nativeAccount)},state=${JSON.stringify(state)};
document.getElementById('connect').onclick=async()=>{const b=document.getElementById('connect'),s=document.getElementById('status');b.disabled=true;try{if(!window.opener)throw Error('请从飞书重新打开连接窗口。');const r=await fetch('${prefix}grant',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({origin,nativeAccount,confirm:true})});const d=await r.json();if(!r.ok)throw Error(d.error);window.opener.postMessage({type:'remotelab:feishu-workspace-connected',state,...d},origin);s.textContent='已连接，请返回飞书。';window.close();}catch(e){s.textContent=e.message;b.disabled=false;}};
</script></html>`);
      return true;
    }
    if (pathname === prefix + 'grant') {
      if (!authSession) return false;
      if (req.method !== 'POST') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
      if (!req.headers.origin || new URL(req.headers.origin).host !== req.headers.host) throw Object.assign(Error('请从账号连接页操作。'), { status: 403 });
      writeJson(res, 201, await connectFeishuWebSettings(JSON.parse(await readBody(req, 32768)), authSession, 'workspace')); return true;
    }
    if (!['context', 'index', 'thinking', 'connection'].some(name => pathname === prefix + name)) { writeJson(res, 404, { error: 'Unknown workspace operation' }); return true; }
    const origin = req.headers.origin;
    if (origin) { try { feishuOrigin(origin); res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); } catch {} }
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method === 'OPTIONS') {
      feishuOrigin(origin); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Feishu-Origin, X-Feishu-Account'); res.writeHead(204); res.end(); return true;
    }
    const actor = await authorizeFeishuWebSettings(req.headers.authorization?.replace(/^Bearer /, ''), req.headers['x-feishu-origin'] || origin, req.headers['x-feishu-account'], 'workspace');
    const operation = pathname.slice(prefix.length);
    if (operation === 'connection' && req.method === 'DELETE') { await disconnectFeishuWebSettings(actor); writeJson(res, 200, { disconnected: true }); }
    else if (operation === 'context' && req.method === 'GET') writeJson(res, 200, await workspace.context(actor));
    else if (['index', 'thinking'].includes(operation) && req.method === 'GET') writeJson(res, 200, await workspace.view(actor, operation, url.searchParams.get('requestId') || ''));
    else if (['index', 'thinking'].includes(operation) && req.method === 'POST') writeJson(res, 202, await workspace.send(actor, operation, JSON.parse(await readBody(req, 32768))));
    else writeJson(res, 405, { error: 'Method not allowed' });
  } catch (error) { writeJson(res, error.status || 400, { error: error.message }); }
  return true;
}
