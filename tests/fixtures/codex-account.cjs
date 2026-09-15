#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const home = process.env.CODEX_HOME;
const auth = path.join(home, 'auth.json');
const fixture = path.join(home, 'provider.json');
const log = path.join(home, 'requests.jsonl');
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
if (process.argv[2] === 'logout') { fs.rmSync(auth, { force: true }); process.exit(0); }
if (process.argv[2] === 'login') {
  console.log('Open https://auth.openai.com/codex/device\nEnter code 2ABC-4DEFG');
  setTimeout(() => { fs.writeFileSync(auth, JSON.stringify({ tokens: {} })); process.exit(0); }, 200);
} else if (process.argv[2] === 'app-server') {
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    fs.appendFileSync(log, JSON.stringify(request) + '\n');
    const data = read(fixture);
    let result;
    if (request.method === 'initialized') return;
    if (request.method === 'initialize') result = {};
    else if (request.method === 'account/read') result = { account: fs.existsSync(auth) ? (data.account || { type: 'chatgpt', email: 'test@example.com', planType: 'pro' }) : null };
    else if (request.method === 'account/rateLimits/read') {
      if (data.hang) return;
      if (data.changeAuth) fs.writeFileSync(auth, data.changeAuth);
      result = data.limits || {};
    } else throw new Error('Unexpected RPC: ' + request.method);
    const response = data.error && request.method === 'account/rateLimits/read'
      ? { id: request.id, error: { code: -1, message: 'SECRET provider credentials' } }
      : { id: request.id, result };
    setTimeout(() => process.stdout.write(JSON.stringify(response) + '\n'), data.delay || 0);
  });
} else process.exit(2);
