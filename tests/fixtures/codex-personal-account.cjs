#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), { randomUUID } = require('node:crypto');
const home = process.env.CODEX_HOME, config = process.env.REMOTELAB_CONFIG_DIR;
const read = name => { try { return JSON.parse(fs.readFileSync(path.join(home, name))); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; } };
const waitFor = name => new Promise(resolve => {
  if (fs.existsSync(path.join(home, name))) return resolve();
  const watch = fs.watch(home, () => { if (fs.existsSync(path.join(home, name))) { watch.close(); resolve(); } });
});
if (process.argv[2] === 'login') {
  process.stdout.write('https://auth.openai.com/codex/device\nABCD-EFGH\n');
  waitFor('approve.json').then(() => {
    const { sub } = read('approve.json');
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: { account_id: 'workspace',
      id_token: 'x.' + Buffer.from(JSON.stringify({ sub })).toString('base64url') + '.x' } }));
    fs.writeFileSync(path.join(home, 'fixture.json'), JSON.stringify({ id: sub, remaining: 100 }));
    fs.unlinkSync(path.join(home, 'approve.json')); process.exit(0);
  });
} else if (process.argv[2] === 'logout') {
  fs.rmSync(path.join(home, 'auth.json'), { force: true }); process.exit(0);
} else {
  let threadId;
  const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
  require('node:readline').createInterface({ input: process.stdin }).on('line', async line => {
    const request = JSON.parse(line), fixture = read('fixture.json'), loggedIn = Boolean(read('auth.json').tokens);
    let result = {};
    if (request.method === 'initialized') return;
    if (request.method === 'account/read') result = { account: loggedIn ? { type: 'chatgpt', email: fixture.id + '@example.invalid', planType: 'pro' } : null };
    if (request.method === 'account/rateLimits/read') result = { rateLimits: { limitId: 'codex', primary: {
      usedPercent: 100 - (fixture.remaining ?? 100), windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 86400 } } };
    if (['thread/start', 'thread/resume'].includes(request.method)) {
      threadId = request.params.threadId || randomUUID(); result = { thread: { id: threadId } };
    }
    if (request.method === 'turn/start') {
      const turnId = randomUUID(); result = { turn: { id: turnId, status: 'inProgress' } };
      fs.appendFileSync(path.join(config, 'personal-invocations.jsonl'), JSON.stringify({ account: fixture.id, threadId, turnId }) + '\n');
      emit({ id: request.id, result }); emit({ method: 'turn/started', params: { threadId, turn: result.turn } });
      if (fixture.hold) await waitFor('release');
      if (fixture.fail?.includes('usage_limit_reached')) fs.writeFileSync(path.join(home, 'fixture.json'), JSON.stringify({ ...fixture, remaining: 0 }));
      if (!fixture.fail) emit({ method: 'item/completed', params: { threadId, turnId, item: {
        id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: 'PERSONAL_OK ' + fixture.id,
      } } });
      emit({ method: 'turn/completed', params: { threadId, turn: { id: turnId,
        status: fixture.fail ? 'failed' : 'completed', ...(fixture.fail ? { error: { message: fixture.fail } } : {}) } } });
      return;
    }
    if (request.method === 'turn/interrupt') process.exit(0);
    emit({ id: request.id, result });
  });
}
