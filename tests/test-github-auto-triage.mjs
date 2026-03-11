#!/usr/bin/env node
import assert from 'assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import http from 'http';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

const repoRoot = process.cwd();
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-github-triage-'));
const configDir = join(tempHome, '.config', 'remotelab');
const binDir = join(tempHome, 'bin');
mkdirSync(configDir, { recursive: true });
mkdirSync(binDir, { recursive: true });

writeFileSync(join(configDir, 'auth.json'), JSON.stringify({
  token: 'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234',
}, null, 2));

const fakeGhStatePath = join(tempHome, 'fake-gh-state.json');
writeFileSync(fakeGhStatePath, JSON.stringify({
  issue: {
    id: 7001,
    number: 7,
    title: 'Bridge test issue',
    body: 'Please confirm the new GitHub connector flow.',
    state: 'open',
    html_url: 'https://github.com/owner/repo/issues/7',
    user: { login: 'alice' },
    created_at: '2026-03-10T00:00:00Z',
    updated_at: '2026-03-10T00:00:00Z',
  },
  comments: [],
}, null, 2));

const ghPath = join(binDir, 'gh');
writeFileSync(ghPath, String.raw`#!/usr/bin/env node
const fs = require('fs');

const statePath = process.env.FAKE_GH_STATE;
const args = process.argv.slice(2);

function readState() {
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

function writeState(state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function endpointFrom(args) {
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-X' || arg === '-f' || arg === '--input' || arg === '--jq') {
      index += 1;
      continue;
    }
    if (arg === '--paginate' || arg === '--slurp') continue;
    if (arg === 'user' || arg.startsWith('repos/')) return arg;
  }
  return '';
}

function methodFrom(args) {
  const index = args.indexOf('-X');
  return index >= 0 ? args[index + 1] : 'GET';
}

function inputPathFrom(args) {
  const index = args.indexOf('--input');
  return index >= 0 ? args[index + 1] : '';
}

if (args[0] === 'api' && args[1] === 'user' && args.includes('--jq')) {
  process.stdout.write('Ninglo\n');
  process.exit(0);
}

if (args[0] !== 'api') {
  console.error('unsupported gh command');
  process.exit(1);
}

const endpoint = endpointFrom(args);
const method = methodFrom(args);
const state = readState();

if (method === 'GET' && endpoint === 'repos/owner/repo/issues') {
  process.stdout.write(JSON.stringify([[state.issue]]) + '\n');
  process.exit(0);
}

if (method === 'GET' && endpoint === 'repos/owner/repo/issues/7') {
  process.stdout.write(JSON.stringify(state.issue) + '\n');
  process.exit(0);
}

if (method === 'GET' && endpoint === 'repos/owner/repo/issues/7/comments') {
  process.stdout.write(JSON.stringify([state.comments]) + '\n');
  process.exit(0);
}

if (method === 'GET' && endpoint === 'repos/owner/repo/pulls/7/reviews') {
  process.stdout.write(JSON.stringify([[]]) + '\n');
  process.exit(0);
}

if (method === 'POST' && endpoint === 'repos/owner/repo/issues/7/comments') {
  const payload = JSON.parse(fs.readFileSync(inputPathFrom(args), 'utf8'));
  const timestamp = '2026-03-10T00:05:00Z';
  const comment = {
    id: 9001,
    html_url: 'https://github.com/owner/repo/issues/7#issuecomment-9001',
    body: payload.body,
    user: { login: 'Ninglo' },
    created_at: timestamp,
    updated_at: timestamp,
  };
  state.comments.push(comment);
  state.issue.updated_at = timestamp;
  writeState(state);
  process.stdout.write(JSON.stringify(comment) + '\n');
  process.exit(0);
}

console.error('unsupported gh api call', method, endpoint, args.join(' '));
process.exit(1);
`);
chmodSync(ghPath, 0o755);

const requests = [];
let submittedRequestId = '';
let submittedText = '';
const assistantReply = 'Thanks — the GitHub connector is now routing through RemoteLab sessions.';

const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) {
    body += chunk.toString();
  }
  requests.push({ method: req.method, url: req.url, body });

  if (req.method === 'GET' && req.url?.startsWith('/?token=')) {
    res.writeHead(302, {
      Location: '/',
      'Set-Cookie': 'session_token=test-cookie; HttpOnly; Path=/',
    });
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/api/sessions') {
    const payload = JSON.parse(body || '{}');
    assert.equal(payload.appId, 'github');
    assert.equal(payload.externalTriggerId, 'github:owner/repo#7');
    assert.equal(payload.tool, 'codex');
    assert.equal(payload.folder, repoRoot);
    assert.equal(payload.group, 'GitHub');
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ session: { id: 'sess_1' } }));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/sessions/sess_1/messages') {
    const payload = JSON.parse(body || '{}');
    submittedRequestId = payload.requestId;
    submittedText = payload.text;
    assert.match(payload.requestId, /^github:owner__repo:7:opened:7001$/);
    assert.match(payload.text, /Source: GitHub/);
    assert.match(payload.text, /Thread: owner\/repo#7/);
    assert.match(payload.text, /Snapshot File:/);
    const snapshotMatch = payload.text.match(/Snapshot File: (.+)/);
    assert.ok(snapshotMatch, 'snapshot path should be included');
    assert.equal(Boolean(snapshotMatch?.[1] && readFileSync(snapshotMatch[1].trim(), 'utf8').includes('# GitHub intake snapshot')), true);
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      duplicate: false,
      run: { id: 'run_1' },
      session: { id: 'sess_1' },
    }));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/runs/run_1') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      run: {
        id: 'run_1',
        sessionId: 'sess_1',
        requestId: submittedRequestId,
        state: 'completed',
      },
    }));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/sessions/sess_1/events') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      sessionId: 'sess_1',
      events: [
        { seq: 1, type: 'message', role: 'user', requestId: submittedRequestId, content: submittedText },
        { seq: 2, type: 'message', role: 'assistant', runId: 'run_1', requestId: submittedRequestId, content: assistantReply },
      ],
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

async function runTriage() {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      join(repoRoot, 'scripts', 'github-auto-triage.mjs'),
      '--repo', 'owner/repo',
      '--post',
      '--only', '7',
      '--chat-base-url', `http://127.0.0.1:${port}`,
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: tempHome,
        PATH: `${binDir}:${process.env.PATH}`,
        FAKE_GH_STATE: fakeGhStatePath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || stdout || `triage exited with ${code}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

try {
  await runTriage();

  const triageStatePath = join(tempHome, '.config', 'remotelab', 'github-triage', 'owner__repo.json');
  const triageState = JSON.parse(readFileSync(triageStatePath, 'utf8'));
  assert.equal(triageState.items['7'].automation.status, 'reply_sent');
  assert.equal(triageState.items['7'].automation.sessionId, 'sess_1');
  assert.equal(triageState.items['7'].automation.runId, 'run_1');
  assert.equal(triageState.items['7'].automation.requestId, submittedRequestId);

  const ghStateAfterFirstRun = JSON.parse(readFileSync(fakeGhStatePath, 'utf8'));
  assert.equal(ghStateAfterFirstRun.comments.length, 1);
  assert.match(ghStateAfterFirstRun.comments[0].body, /Thanks — the GitHub connector is now routing through RemoteLab sessions\./);
  assert.match(ghStateAfterFirstRun.comments[0].body, /remotelab-github-auto-triage/);
  assert.match(ghStateAfterFirstRun.comments[0].body, /remotelab-github-request-id:/);

  await runTriage();

  const ghStateAfterSecondRun = JSON.parse(readFileSync(fakeGhStatePath, 'utf8'));
  assert.equal(ghStateAfterSecondRun.comments.length, 1, 'second run should not duplicate the GitHub comment');
  assert.equal(requests.filter((request) => request.method === 'POST' && request.url === '/api/sessions').length, 1);
  assert.equal(requests.filter((request) => request.method === 'POST' && request.url === '/api/sessions/sess_1/messages').length, 1);
} finally {
  server.close();
  rmSync(tempHome, { recursive: true, force: true });
}

console.log('github auto triage tests passed');
