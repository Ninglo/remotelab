import { readBody, escapeHtml } from '../lib/utils.mjs';
import { authorizeFeishuWebSettings, connectFeishuWebSettings, disconnectFeishuWebSettings, feishuOrigin } from './feishu-web-settings.mjs';
import { feishuTopicSource, topicIds } from './feishu-web-topics.mjs';

const prefix = '/api/feishu-web-topics/';
export async function handleFeishuWebTopics({ req, res, pathname, authSession, writeJson, nonce, source = feishuTopicSource }) {
  if (!pathname.startsWith(prefix) && pathname !== '/page/feishu-web-topics/connect') return false;
  const url = new URL(req.url, 'http://localhost');
  try {
    if (pathname === '/page/feishu-web-topics/connect') {
      if (!authSession) return false;
      const origin = feishuOrigin(url.searchParams.get('origin')), account = url.searchParams.get('account'), state = url.searchParams.get('state');
      if (req.method !== 'GET' || authSession.authKind === 'service' || !/^\d{10,30}$/.test(account || '') || !/^[a-f0-9]{32}$/.test(state || '')) throw Error('请从插件重新连接状态同步。');
      res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
      res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>连接话题状态同步</title><style>body{font:16px/1.7 system-ui;margin:32px;max-width:440px;color:#1f2329}button{font:inherit;padding:10px 18px;cursor:pointer}</style><h2>连接话题状态同步</h2><p>当前登录：<strong>${escapeHtml(authSession.personName || '')}</strong></p><p>只读取当前飞书列表中已核实对应的话题标题、摘要和运行状态。不会修改消息、执行任务或读取私聊正文。</p><p>请核对姓名是你。</p><button id="connect">连接这个账号</button><p id="status"></p><script nonce="${nonce}">const origin=${JSON.stringify(origin)},nativeAccount=${JSON.stringify(account)},state=${JSON.stringify(state)};document.getElementById('connect').onclick=async()=>{const b=document.getElementById('connect');b.disabled=true;try{if(!window.opener)throw Error('请从飞书重新打开连接页。');const r=await fetch('${prefix}grant',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({origin,nativeAccount,confirm:true})}),d=await r.json();if(!r.ok)throw Error(d.error);window.opener.postMessage({type:'remotelab:feishu-topics-connected',state,...d},origin);window.close();}catch(e){document.getElementById('status').textContent=e.message;b.disabled=false;}};</script></html>`); return true;
    }
    if (pathname === prefix + 'grant') {
      if (!authSession) return false;
      if (req.method !== 'POST' || !req.headers.origin || new URL(req.headers.origin).host !== req.headers.host) throw Object.assign(Error('请从本人连接页操作。'), { status: 403 });
      writeJson(res, 201, await connectFeishuWebSettings(JSON.parse(await readBody(req, 32768)), authSession, 'topics')); return true;
    }
    const origin = req.headers.origin;
    if (origin) { try { feishuOrigin(origin); res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); } catch {} }
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method === 'OPTIONS') { feishuOrigin(origin); res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE'); res.setHeader('Access-Control-Allow-Headers', 'Authorization, X-Feishu-Origin, X-Feishu-Account'); res.writeHead(204); res.end(); return true; }
    const authorize = () => authorizeFeishuWebSettings(req.headers.authorization?.replace(/^Bearer /, ''), req.headers['x-feishu-origin'] || origin, req.headers['x-feishu-account'], 'topics');
    const actor = await authorize();
    if (pathname === prefix + 'connection' && req.method === 'DELETE') { await disconnectFeishuWebSettings(actor); writeJson(res, 200, { disconnected: true }); return true; }
    if (!['snapshot', 'stream'].some(name => pathname === prefix + name) || req.method !== 'GET') { writeJson(res, 404, { error: 'Unknown topic operation' }); return true; }
    const ids = topicIds(url.searchParams.get('ids'));
    if (pathname.endsWith('/snapshot')) { writeJson(res, 200, await source.snapshot(ids)); return true; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' }); res.flushHeaders?.();
    let off, closed = false;
    const stop = () => { if (closed) return; closed = true; clearInterval(heartbeat); off?.(); res.end(); };
    const send = data => { if (!closed) res.write('data: ' + JSON.stringify(data) + '\n\n'); };
    const heartbeat = setInterval(() => { void authorize().then(() => { if (!closed) res.write(': heartbeat\n\n'); }).catch(() => stop()); }, 15000); heartbeat.unref?.();
    res.on('close', stop);
    off = await source.subscribe(ids, send, error => { send({ sourceConnected: false, error: error.message }); stop(); });
    if (closed) off();
  } catch (error) { if (res.headersSent) res.end(); else writeJson(res, error.status || 400, { error: error.message }); }
  return true;
}
