#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const home = process.env.CODEX_HOME;
const fixture = JSON.parse(fs.readFileSync(path.join(home, 'fixture.json')));
const log = path.join(process.env.REMOTELAB_CONFIG_DIR, 'failover-invocations.jsonl');
const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
if (process.argv.includes('app-server')) {
  let resumeId = null;
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line); let result;
    if (request.method === 'initialized') return;
    if (request.method === 'initialize') result = {};
    else if (request.method === 'account/read') result = { account: { type: 'chatgpt', email: fixture.id + '@example.invalid', planType: 'pro' } };
    else if (request.method === 'account/rateLimits/read') result = { rateLimits: { limitId: 'codex',
      primary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 86400 } } };
    else if (request.method === 'thread/start' || request.method === 'thread/resume') {
      resumeId = request.params?.threadId || null;
      result = { thread: { id: '00000000-0000-4000-8000-000000000001' } };
    } else if (request.method === 'turn/start') {
      result = { turn: { id: 'turn-1', status: 'inProgress' } };
      fs.appendFileSync(log, JSON.stringify({ account: fixture.id, native: true, resumeId }) + '\n');
      setImmediate(() => {
        const threadId = '00000000-0000-4000-8000-000000000001';
        emit({ method: 'turn/started', params: { threadId, turn: result.turn } });
        if (fixture.fail && fixture.tool) {
          fs.appendFileSync(path.join(process.env.REMOTELAB_CONFIG_DIR, 'external-effect.txt'), 'once\n');
          emit({ method: 'item/completed', params: { threadId, turnId: 'turn-1', item: {
            id: 'action-1', type: 'commandExecution', command: 'synthetic effect', status: 'completed', exitCode: 0 } } });
        }
        if (!fixture.fail) {
          if (!resumeId) throw new Error('Native failover must resume');
          emit({ method: 'item/completed', params: { threadId, turnId: 'turn-1', item: {
            id: 'answer', type: 'agentMessage', text: 'CONTINUED' } } });
        }
        emit({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-1',
          status: fixture.fail ? 'failed' : 'completed', ...(fixture.fail ? { error: { message: fixture.fail } } : {}) } } });
      });
    }
    else throw new Error('Unexpected method ' + request.method);
    emit({ id: request.id, result });
  });
} else {
  const args = process.argv.slice(2);
  fs.appendFileSync(log, JSON.stringify({ account: fixture.id, args }) + '\n');
  emit({ type: 'thread.started', thread_id: '00000000-0000-4000-8000-000000000001' });
  if (fixture.fail) {
    if (fixture.tool) {
      fs.appendFileSync(path.join(process.env.REMOTELAB_CONFIG_DIR, 'external-effect.txt'), 'once\n');
      emit({ type: 'item.completed', item: { id: 'action-1', type: 'command_execution', command: 'synthetic effect', status: 'completed', exit_code: 0 } });
    }
    emit({ type: 'turn.failed', error: { message: fixture.fail } }); process.exit(1);
  }
  if (!args.includes('resume')) throw new Error('Failover must resume the saved thread');
  emit({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'CONTINUED' } });
  emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
}
