#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const readline = require('node:readline');
const home = process.env.CODEX_HOME;
const config = process.env.REMOTELAB_CONFIG_DIR;
let threadId;
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const request = JSON.parse(line);
  const fixture = JSON.parse(fs.readFileSync(path.join(home, 'fixture.json')));
  let result = {};
  if (request.method === 'initialized') return;
  if (request.method === 'account/read') result = { account: { type: 'chatgpt', email: fixture.id + '@example.invalid', planType: 'pro' } };
  if (request.method === 'account/rateLimits/read') result = { rateLimits: { limitId: 'codex', primary: {
    usedPercent: 0, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 86400 } } };
  if (request.method === 'thread/start' || request.method === 'thread/resume') {
    threadId = request.params.threadId || randomUUID(); result = { thread: { id: threadId } };
  }
  if (request.method === 'turn/start') {
    const turnId = randomUUID(); result = { turn: { id: turnId, status: 'inProgress' } };
    fs.appendFileSync(path.join(config, 'balance-invocations.jsonl'), JSON.stringify({ account: fixture.id, threadId, turnId, params: request.params }) + '\n');
    emit({ id: request.id, result });
    emit({ method: 'turn/started', params: { threadId, turn: result.turn } });
    if (fixture.hold) {
      await new Promise(resolve => {
        const release = path.join(config, 'release');
        if (fs.existsSync(release)) return resolve();
        const watch = fs.watch(config, () => { if (fs.existsSync(release)) { watch.close(); resolve(); } });
        if (fs.existsSync(release)) { watch.close(); resolve(); }
      });
    }
    if (!fixture.fail) emit({ method: 'item/completed', params: { threadId, turnId, item: {
      id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: 'BALANCE_OK ' + fixture.id,
    } } });
    emit({ method: 'turn/completed', params: { threadId, turn: { id: turnId,
      status: fixture.fail ? 'failed' : 'completed', ...(fixture.fail ? { error: { message: fixture.fail } } : {}) } } });
    return;
  }
  if (request.method === 'turn/interrupt') process.exit(0);
  emit({ id: request.id, result });
});
