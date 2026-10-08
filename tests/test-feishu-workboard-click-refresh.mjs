import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';

const root = await mkdtemp(join(tmpdir(), 'workboard-click-'));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const session = id => ({ id, workboardPilot: true, conversation: { connector: 'feishu', sourceRouteId: 'default',
  target: { chatId: 'group', chatType: 'group', conversationKind: 'thread' } } });
const events = [{ seq: 1, type: 'message', role: 'user', runId: 'run', sourceContext: { connector: 'feishu',
  sourceRouteId: 'default', chatId: 'group', chatType: 'group', messageId: 'input', sender: { openId: 'person' } },
  workboardAdmission: { personId: 'p', identityId: 'i', sourceRouteId: 'default', senderOpenId: 'person' } },
{ seq: 2, type: 'message', role: 'assistant', runId: 'run', source: 'workboard_checklist',
  workboard: { taskId: 'task', goal: '交付', revision: 1, status: 'running', reason: '',
    items: [{ id: 'item', title: '交付', condition: '核对', status: 'pending', evidenceRefs: [] }] } },
{ seq: 3, type: 'message', role: 'assistant', runId: 'run', phase: 'commentary', content: '<progress>真实过程</progress>' }];
const calls = [];
const trace = [];
let historyReads = 0;
let holdPatch = null;
const bootGate = deferred();
let holdBusy = bootGate;
let patchObserved = deferred();
let busyObserved = deferred();
const server = createServer(async (req, res) => {
  trace.push(req.url);
  const json = value => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (req.url.startsWith('/?token=')) { res.writeHead(302, { 'set-cookie': 'session_token=fixture' }); res.end(); return; }
  if (req.url === '/provider/patch') {
    let body = ''; for await (const chunk of req) body += chunk;
    calls.push({ ...JSON.parse(body), historyReads }); patchObserved.resolve();
    const gate = holdPatch; holdPatch = null; if (gate) await gate.promise;
    json({ code: 0 }); return;
  }
  if (req.url === '/api/sessions?sourceId=feishu') { json({ sessions: [session('busy'), session('s')] }); return; }
  if (req.url.startsWith('/api/sessions/busy')) {
    const gate = holdBusy; holdBusy = null;
    busyObserved.resolve(); if (gate) await gate.promise;
    json(req.url.includes('/events') ? { events: [] } : { session: session('busy') }); return;
  }
  if (req.url.startsWith('/api/sessions/s/events')) { historyReads++; json({ events }); return; }
  if (req.url.startsWith('/api/sessions/s')) { json({ session: session('s') }); return; }
  res.writeHead(404); res.end();
});
const sockets = new WebSocketServer({ server });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
await writeFile(join(root, 'auth.json'), JSON.stringify({ version: 2, serviceToken: 'fixture', people: [{ id: 'p', name: 'Fixture' }] }));
await writeFile(join(root, 'bot.json'), JSON.stringify({ appId: 'fixture', appSecret: 'fixture', chatBaseUrl: baseUrl }));
const statePath = join(root, 'state.json');
await writeFile(statePath, JSON.stringify({ scope: 'instance', sourceRouteId: 'default', botConfigPath: join(root, 'bot.json'),
  protocolVersion: 2, sessions: { busy: { chatId: 'group', cards: [], protocolAfterSeq: 0 }, s: { chatId: 'group', protocolAfterSeq: 0,
    cards: [{ messageId: 'original', anchorSeq: 2, taskId: 'task', latestSeq: 3 }] } } }));
// Substitute only the provider SDK in this isolated child; no real Feishu
// credentials, calls or production test switches are involved.
await writeFile(join(root, 'sdk.mjs'), `export const Domain={Feishu:'fixture',Lark:'fixture'};export const LoggerLevel={warn:0};
export class Client { constructor(){this.im={v1:{message:{
patch:async input=>{const response=await fetch(${JSON.stringify(baseUrl + '/provider/patch')},{method:'POST',body:JSON.stringify(input)});return response.json()},
get:async input=>({code:0,data:{items:[{message_id:input.path.message_id,chat_id:'group',msg_type:'interactive',updated:true}]}})
}}}}}
`);
await writeFile(join(root, 'loader.mjs'), `export async function resolve(specifier,context,next){if(specifier==='@larksuiteoapi/node-sdk')return {url:new URL('./sdk.mjs',import.meta.url).href,shortCircuit:true};return next(specifier,context)}\n`);
const connected = once(sockets, 'connection');
const child = spawn(process.execPath, ['--loader', join(root, 'loader.mjs'), 'scripts/feishu-workboard-pilot.mjs', statePath], {
  env: { ...process.env, REMOTELAB_CONFIG_DIR: root }, stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
const listeners = new Set();
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output += data; for (const listener of listeners) listener(); });
function awaitOutput(pattern, after = 0) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { listeners.delete(check); reject(new Error(`Missing ${pattern}: ${output}`)); }, 10000);
    const check = () => { if (pattern.test(output.slice(after))) { clearTimeout(timer); listeners.delete(check); resolve(); } };
    listeners.add(check); check();
  });
}
try {
  const [socket] = await connected;
  const hint = (mode, revision) => socket.send(JSON.stringify({ type: 'session_invalidated', sessionId: 's',
    progressCard: { anchorSeq: 2, sourceRouteId: 'default', chatId: 'group', mode, revision } }));
  const barrier = async () => { const pong = once(socket, 'pong'); socket.ping(); await pong; };
  await busyObserved.promise;
  hint('expanded', 1); await barrier(); bootGate.resolve();
  await awaitOutput(/ready route=default scope=instance/);
  assert.equal(JSON.parse(calls[0].data.content).body.elements.find(e => e.tag === 'button').text.content,
    '点击折叠进展', 'a cold-start click is received before the bootstrap backlog finishes');
  const beforeReads = historyReads;
  const beforeCalls = calls.length;
  const offset = output.length;
  const gate = deferred(); holdPatch = gate; patchObserved = deferred();
  hint('expanded', 2); await patchObserved.promise;
  hint('collapsed', 3); hint('expanded', 4); hint('collapsed', 5);
  await barrier(); gate.resolve();
  await awaitOutput(/disclosure .*anchor=2/, offset);
  await awaitOutput(/disclosure .*anchor=2[\s\S]*disclosure .*anchor=2/, offset);
  assert.equal(historyReads, beforeReads, 'clicks repaint without another history request');
  assert.equal(calls.length, beforeCalls + 2, 'queued clicks coalesce to the newest absolute choice');
  assert.equal(JSON.parse(calls.at(-1).data.content).body.elements.find(e => e.tag === 'button').text.content, '点击显示进展');
  assert.equal(calls.at(-1).path.message_id, 'original');

  // An automatic refresh already in flight must finish; the click then goes
  // before another queued full refresh, through the same provider writer.
  const busyGate = deferred(); holdBusy = busyGate; busyObserved = deferred();
  socket.send(JSON.stringify({ type: 'session_invalidated', sessionId: 'busy' }));
  await busyObserved.promise;
  const beforeQueuedRefresh = historyReads;
  events.push({ ...events[2], seq: 4, content: '<progress>新的过程</progress>' });
  socket.send(JSON.stringify({ type: 'session_invalidated', sessionId: 's' }));
  hint('expanded', 6); await barrier();
  patchObserved = deferred(); busyGate.resolve(); await patchObserved.promise;
  assert.equal(calls.at(-1).historyReads, beforeQueuedRefresh, `human click precedes the queued history refresh: ${JSON.stringify(trace)}`);
  const content = JSON.parse(calls.at(-1).data.content);
  assert.equal(content.body.elements.find(e => e.tag === 'button').text.content, '点击折叠进展');
  assert.match(JSON.stringify(content), /真实过程/);
  await awaitOutput(/updated session=s anchor=2 revision=4/);
  const refreshed = JSON.parse(calls.at(-1).data.content);
  assert.equal(refreshed.body.elements.find(e => e.tag === 'button').text.content, '点击折叠进展', 'ordinary refresh with older metadata preserves the accepted click');
  assert.match(JSON.stringify(refreshed), /新的过程/);
  console.log('PASS: actual route worker repaints clicks without history I/O, coalesces rapid choices and prioritizes them over automatic refreshes.');
} finally {
  bootGate.resolve(); holdPatch?.resolve(); holdBusy?.resolve();
  if (child.exitCode === null && child.signalCode === null) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped; }
  for (const socket of sockets.clients) socket.terminate();
  await new Promise(resolve => sockets.close(resolve));
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
