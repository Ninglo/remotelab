import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { handleTrialRoutes } from './routes.mjs';
import { startTrialWorker, stopTrialWorker } from './service.mjs';

// Companion app: one existing native control plane, no additional chat server.
const config = JSON.parse(await readFile(process.env.REMOTELAB_TRIAL_CONFIG, 'utf8'));
const digest = text => createHash('sha256').update(text).digest();
const expected = Buffer.from(config.credentialSha256, 'hex');
function authenticated(req) {
  try {
    if (!req.headers.authorization?.startsWith('Basic ')) return false;
    return timingSafeEqual(digest(Buffer.from(req.headers.authorization.slice(6), 'base64').toString()), expected);
  } catch { return false; }
}
const writeJson = (res, status, value) => { res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store' }); res.end(JSON.stringify(value)); };
const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','no-referrer'); res.setHeader('X-Robots-Tag','noindex');
  if (!authenticated(req)) { res.writeHead(401, { 'WWW-Authenticate':'Basic realm="RemoteLab automation trial", charset="UTF-8"' }); res.end('请使用本次试用账号登录'); return; }
  try {
    let pathname = new URL(req.url,'http://local').pathname;
    if (pathname==='/' || pathname==='/index.html') pathname='/automation-trial/';
    if (pathname==='/app.js' || pathname==='/style.css') pathname='/automation-trial'+pathname;
    if (!await handleTrialRoutes({req,res,pathname,authSession:config.actor,writeJson})) writeJson(res,404,{error:'Not found'});
  } catch(e) { if(!res.headersSent)writeJson(res,500,{error:e.message}); else res.end(); }
});
server.listen(config.port,'127.0.0.1',()=>{startTrialWorker();console.log(`Automation trial listening on 127.0.0.1:${config.port}`);});
const stop=()=>{stopTrialWorker();server.close();server.closeIdleConnections?.();};
process.on('SIGTERM',stop);process.on('SIGINT',stop);
