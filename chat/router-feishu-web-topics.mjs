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
      res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>连接话题状态同步</title><style>body{font:16px/1.7 system-ui;margin:32px;max-width:440px;color:#1f2329}button{font:inherit;padding:10px 18px;cursor:pointer}</style><h2>连接话题状态同步</h2><p>当前登录：<strong>${escapeHtml(authSession.personName || '')}</strong></p><p>读取当前飞书列表中已核实对应的话题标题、摘要和运行状态，以及当前群看板。${origin === 'http://127.0.0.1:19342' ? '同时显示这些话题的用量、额度和已登记网页成果。' : ''}在飞书读过结果后，将同步标记对应 RemoteLab 结果为已读。不会修改消息、执行任务或读取私聊正文。</p><p>请核对姓名是你。</p><button id="connect">连接这个账号</button><p id="status"></p><script nonce="${nonce}">const origin=${JSON.stringify(origin)},nativeAccount=${JSON.stringify(account)},state=${JSON.stringify(state)};document.getElementById('connect').onclick=async()=>{const b=document.getElementById('connect');b.disabled=true;try{if(!window.opener)throw Error('请从飞书重新打开连接页。');const r=await fetch('${prefix}grant',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({origin,nativeAccount,confirm:true,topicDetails:origin==='http://127.0.0.1:19342',topicReadAck:true})}),d=await r.json();if(!r.ok)throw Error(d.error);window.opener.postMessage({type:'remotelab:feishu-topics-connected',state,...d},origin);window.close();}catch(e){document.getElementById('status').textContent=e.message;b.disabled=false;}};</script></html>`); return true;
    }
    if (pathname === prefix + 'grant') {
      if (!authSession) return false;
      if (req.method !== 'POST' || !req.headers.origin || new URL(req.headers.origin).host !== req.headers.host) throw Object.assign(Error('请从本人连接页操作。'), { status: 403 });
      writeJson(res, 201, await connectFeishuWebSettings(JSON.parse(await readBody(req, 32768)), authSession, 'topics')); return true;
    }
    const origin = req.headers.origin;
    if (origin) { try { feishuOrigin(origin); res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); } catch {} }
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method === 'OPTIONS') { feishuOrigin(origin); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE'); res.setHeader('Access-Control-Allow-Headers', 'Authorization, X-Feishu-Origin, X-Feishu-Account'); res.writeHead(204); res.end(); return true; }
    if (pathname === prefix + 'activate' && req.method === 'POST') {
      const feishu = req.headers['x-feishu-origin'] || origin, account = req.headers['x-feishu-account'];
      const actor = await authorizeFeishuWebSettings(req.headers.authorization?.replace(/^Bearer /, ''), feishu, account, 'workspace');
      // The same Person already confirmed this exact native account. Reuse that
      // identity while retaining a separate read-only token and expiry boundary.
      writeJson(res, 201, await connectFeishuWebSettings({ origin: feishu, nativeAccount: account, confirm: true }, actor, 'topics')); return true;
    }
    const authorize = () => authorizeFeishuWebSettings(req.headers.authorization?.replace(/^Bearer /, ''), req.headers['x-feishu-origin'] || origin, req.headers['x-feishu-account'], 'topics');
    const actor = await authorize();
    if (pathname === prefix + 'connection' && req.method === 'DELETE') { await disconnectFeishuWebSettings(actor); writeJson(res, 200, { disconnected: true }); return true; }
    if (pathname === prefix + 'review' && req.method === 'POST') {
      if (!actor.topicReadAck) throw Object.assign(Error('请重新连接状态同步，启用飞书已读同步。'), { status: 403 });
      const body = JSON.parse(await readBody(req, 2048));
      if (!body || Object.keys(body).some(k => !['webThreadId', 'resultAt'].includes(k)) || topicIds(body.webThreadId).length !== 1) throw Error('已读请求无效。');
      writeJson(res, 200, await source.review(body.webThreadId, body.resultAt)); return true;
    }
    // Empty summaries let native v14 restore Feishu's latest-message preview.
    // Group-board and Web summaries retain their existing presentation.
    const native = (req.headers['x-feishu-origin'] || origin) === 'http://127.0.0.1:19342';
    const project = data => ({ ...data, ...(native ? { entries: (data.entries || []).map(e => ({ ...e, summary: '' })) } : {}), readSyncEnabled: actor.topicReadAck });
    if (!['snapshot', 'stream'].some(name => pathname === prefix + name) || req.method !== 'GET') { writeJson(res, 404, { error: 'Unknown topic operation' }); return true; }
    const ids = topicIds(url.searchParams.get('ids')), groups = topicIds(url.searchParams.get('groups'));
    if (pathname.endsWith('/snapshot')) { writeJson(res, 200, project(await source.snapshot(ids, '', null, groups, actor.topicDetails))); return true; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' }); res.flushHeaders?.();
    let off, closed = false;
    const stop = () => { if (closed) return; closed = true; clearInterval(heartbeat); off?.(); res.end(); };
    const send = data => { if (!closed) res.write('data: ' + JSON.stringify(project(data)) + '\n\n'); };
    const heartbeat = setInterval(() => { void authorize().then(() => { if (!closed) res.write(': heartbeat\n\n'); }).catch(() => stop()); }, 15000); heartbeat.unref?.();
    res.on('close', stop);
    off = await source.subscribe(ids, send, error => { send({ sourceConnected: false, error: error.message }); stop(); }, groups, actor.topicDetails);
    if (closed) off();
  } catch (error) { if (res.headersSent) res.end(); else writeJson(res, error.status || 400, { error: error.message }); }
  return true;
}
