import { readBody, escapeHtml } from '../lib/utils.mjs';
import { observeIntervention } from './usage-controls.mjs';
import { connectFeishuWebSettings, authorizeFeishuWebSettings, disconnectFeishuWebSettings,
  loadFeishuWebReplies, saveFeishuWebReplies, readFeishuWebRuntime, saveFeishuWebRuntime, feishuOrigin } from './feishu-web-settings.mjs';

const prefix = '/api/feishu-web-settings/';
export const FEISHU_WEB_CONNECT_PATH = '/page/feishu-web-settings/connect';
export async function handleFeishuWebSettings({ req, res, pathname, parsedUrl, authSession, writeJson, nonce, runtime }) {
  if (!pathname.startsWith(prefix) && pathname !== FEISHU_WEB_CONNECT_PATH) return false;
  const url = new URL(req.url, 'http://localhost');
  try {
    if (pathname === FEISHU_WEB_CONNECT_PATH) {
      if (!authSession) return false;
      if (req.method !== 'GET') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
      const origin = feishuOrigin(url.searchParams.get('origin'));
      const nativeAccount = url.searchParams.get('account'), state = url.searchParams.get('state');
      if (!/^\d{10,30}$/.test(nativeAccount || '') || !/^[a-f0-9]{32}$/.test(state || '')) throw new Error('请重新从飞书设置打开连接。');
      if (authSession.authKind === 'service') throw Object.assign(new Error('请用本人的登录账号连接。'), { status: 403 });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>连接消息设置</title><style>body{font:16px/1.7 system-ui;margin:32px;max-width:440px;color:#1f2329}button{padding:10px 18px;background:#245bdb;color:white;border:0;border-radius:6px;cursor:pointer}p{margin:16px 0}small{color:#646a73}</style><h2>连接我的消息设置</h2><p>当前登录：<strong>${escapeHtml(authSession.personName || '')}</strong></p><p>连接后，可直接在飞书设置你的回复展示、开工严格检查、实验分流和当前对话模型。</p><small>请确认上面的姓名是你。个人设置适用于你后续发起的新工作；对话模型作用于当前对话的后续消息。</small><p><button id="connect">连接这个账号</button></p><p id="status" role="status"></p><script nonce="${nonce}">
const origin=${JSON.stringify(origin)},nativeAccount=${JSON.stringify(nativeAccount)},state=${JSON.stringify(state)};
document.getElementById('connect').onclick=async()=>{const button=document.getElementById('connect'),status=document.getElementById('status');button.disabled=true;try{if(!window.opener)throw Error('连接窗口已失去来源，请从飞书重新打开。');const response=await fetch('/api/feishu-web-settings/grant',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({origin,nativeAccount,confirm:true})});const result=await response.json();if(!response.ok)throw Error(result.error);window.opener.postMessage({type:'remotelab:feishu-settings-connected',state,...result},origin);status.textContent='已连接，返回飞书即可设置。';window.close();}catch(error){status.textContent=error.message;button.disabled=false;}};
</script></html>`);
      return true;
    }
    if (pathname === prefix + 'grant') {
      if (!authSession) return false;
      if (req.method !== 'POST') { writeJson(res, 405, { error: 'Method not allowed' }); return true; }
      if (!req.headers.origin || new URL(req.headers.origin).host !== req.headers.host) throw Object.assign(new Error('请从账号连接页操作。'), { status: 403 });
      writeJson(res, 201, await connectFeishuWebSettings(JSON.parse(await readBody(req, 32768)), authSession));
      return true;
    }
    if (!['replies', 'runtime', 'connection'].some(name => pathname === prefix + name)) { writeJson(res, 404, { error: 'Unknown settings operation' }); return true; }
    const corsOrigin = req.headers.origin;
    if (corsOrigin) {
      try { feishuOrigin(corsOrigin); res.setHeader('Access-Control-Allow-Origin', corsOrigin); res.setHeader('Vary', 'Origin'); } catch {}
    }
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method === 'OPTIONS') {
      feishuOrigin(corsOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Feishu-Origin, X-Feishu-Account');
      res.writeHead(204); res.end(); return true;
    }
    const token = req.headers.authorization?.replace(/^Bearer /, '');
    const actor = await authorizeFeishuWebSettings(token, req.headers['x-feishu-origin'] || corsOrigin, req.headers['x-feishu-account']);
    if (pathname.endsWith('/connection') && req.method === 'DELETE') {
      await disconnectFeishuWebSettings(actor); writeJson(res, 200, { disconnected: true });
    } else if (pathname.endsWith('/replies') && req.method === 'GET') {
      writeJson(res, 200, { settings: await loadFeishuWebReplies(actor), person: { id: actor.personId, name: actor.personName } });
    } else if (pathname.endsWith('/replies') && req.method === 'POST') {
      writeJson(res, 200, { settings: await saveFeishuWebReplies(JSON.parse(await readBody(req, 32768)), actor) });
    } else if (pathname.endsWith('/runtime') && req.method === 'GET') {
      writeJson(res, 200, { runtime: await readFeishuWebRuntime(url.searchParams.get('sessionId'), runtime) });
    } else if (pathname.endsWith('/runtime') && req.method === 'POST') {
      const input = JSON.parse(await readBody(req, 32768));
      const saved = await saveFeishuWebRuntime(input, runtime);
      observeIntervention(input.sessionId, 'runtime_change', actor);
      writeJson(res, 200, { runtime: saved });
    } else writeJson(res, 405, { error: 'Method not allowed' });
  } catch (error) { writeJson(res, error.status || 400, { error: error.message }); }
  return true;
}
