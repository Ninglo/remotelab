#!/usr/bin/env node
import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import http from 'http';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const repoRoot = process.cwd();
const tempHome = mkdtempSync(join(tmpdir(), 'remotelab-agent-mail-worker-'));
process.env.HOME = tempHome;

const mailboxRoot = join(tempHome, '.config', 'remotelab', 'agent-mailbox');
mkdirSync(join(tempHome, '.config', 'remotelab'), { recursive: true });
writeFileSync(join(tempHome, '.config', 'remotelab', 'auth.json'), JSON.stringify({
  token: 'abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234',
}, null, 2));

const {
  buildEmailThreadExternalTriggerId,
  findQueueItem,
  initializeMailbox,
  ingestRawMessage,
  mailboxPaths,
  saveMailboxAutomation,
} = await import(pathToFileURL(join(repoRoot, 'lib', 'agent-mailbox.mjs')).href);
const { saveUiRuntimeSelection } = await import(pathToFileURL(join(repoRoot, 'lib', 'runtime-selection.mjs')).href);
const {
  createRemoteLabRuntime,
  ensureAuthCookie,
  requestRemoteLab,
} = await import(pathToFileURL(join(repoRoot, 'scripts', 'agent-mail-worker.mjs')).href);

const authRefreshRuntime = createRemoteLabRuntime('http://127.0.0.1:7690');
authRefreshRuntime.authCookie = 'session_token=stale-cookie';
authRefreshRuntime.authToken = 'stale-token';
authRefreshRuntime.readOwnerToken = async () => 'fresh-token';
authRefreshRuntime.loginWithToken = async (_baseUrl, token) => `session_token=${token}`;

assert.equal(
  await ensureAuthCookie(authRefreshRuntime, false),
  'session_token=stale-cookie',
  'mail worker should reuse a cached cookie when no refresh is needed',
);
assert.equal(
  await ensureAuthCookie(authRefreshRuntime, true),
  'session_token=fresh-token',
  'mail worker should reread the current owner token on forced auth refresh',
);

const retryProbeRuntime = createRemoteLabRuntime('http://127.0.0.1:7690');
retryProbeRuntime.authCookie = 'session_token=stale-cookie';
retryProbeRuntime.authToken = 'stale-token';
retryProbeRuntime.readOwnerToken = async () => 'fresh-token';
retryProbeRuntime.loginWithToken = async (_baseUrl, token) => `session_token=${token === 'fresh-token' ? 'fresh-cookie' : token}`;
const retryProbeCookies = [];
retryProbeRuntime.requestJson = async (_baseUrl, _path, options = {}) => {
  retryProbeCookies.push(options.cookie || '');
  if (options.cookie === 'session_token=stale-cookie') {
    return { response: { status: 401, ok: false }, json: { error: 'unauthorized' }, text: 'unauthorized' };
  }
  return { response: { status: 200, ok: true }, json: { ok: true }, text: '{"ok":true}' };
};

const retryProbeResult = await requestRemoteLab(retryProbeRuntime, '/api/probe');
assert.equal(retryProbeResult.response.status, 200, 'mail worker should retry after an auth failure');
assert.deepEqual(
  retryProbeCookies,
  ['session_token=stale-cookie', 'session_token=fresh-cookie'],
  'mail worker should retry with a refreshed cookie after a 401/403 response',
);

const requests = [];
const sessionCreates = [];
const messageSubmissions = [];
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) {
    body += chunk.toString();
  }
  requests.push({ method: req.method, url: req.url, headers: req.headers, body });

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
    sessionCreates.push(payload);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ session: { id: 'sess_1' } }));
    return;
  }

  if (req.method === 'POST' && /^\/api\/sessions\/[^/]+\/messages$/.test(req.url || '')) {
    const payload = JSON.parse(body || '{}');
    assert.match(payload.text, /User message:/);
    messageSubmissions.push(payload);
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      duplicate: false,
      run: { id: `run_${messageSubmissions.length}` },
      session: { id: 'sess_1' },
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

try {
  await initializeMailbox({
    rootDir: mailboxRoot,
    name: 'Rowan',
    localPart: 'rowan',
    domain: 'example.com',
    allowEmails: ['owner@example.com'],
  });

  await saveMailboxAutomation(mailboxRoot, {
    allowlistAutoApprove: true,
    chatBaseUrl: `http://127.0.0.1:${port}`,
    session: {
      folder: '~',
      tool: 'codex',
      group: 'Mail',
      description: 'Inbound email',
      systemPrompt: 'Reply with plain text only.',
    },
  });

  await saveUiRuntimeSelection({
    selectedTool: 'claude',
    selectedModel: 'claude-sonnet-4-5',
    thinkingEnabled: true,
    reasoningKind: 'toggle',
  });

  const ingested = await ingestRawMessage(
    [
      'From: owner@example.com',
      'To: rowan@example.com',
      'Subject: hello!',
      'Message-ID: <root-thread@example.com>',
      'Content-Type: text/plain; charset=UTF-8',
      '',
      'please take a response to test!',
    ].join('\n'),
    'test.eml',
    mailboxRoot,
    { text: 'please take a response to test!' },
  );
  const approved = (await findQueueItem(ingested.id, mailboxRoot))?.item;
  assert.equal(approved?.queue, 'approved');
  assert.equal(approved?.review?.status, 'auto_approved');

  const firstWorker = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(repoRoot, 'scripts', 'agent-mail-worker.mjs'), '--once', '--root', mailboxRoot], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
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
        reject(new Error(stderr || `worker exited with ${code}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });

  const firstSummary = JSON.parse(firstWorker.stdout);
  assert.equal(firstSummary.processed, 1);
  assert.equal(firstSummary.failures.length, 0);
  assert.equal(requests.length, 3);

  const expectedThreadTriggerId = buildEmailThreadExternalTriggerId({
    messageId: '<root-thread@example.com>',
  });
  assert.equal(sessionCreates.length, 1);
  assert.equal(sessionCreates[0].sourceId, 'email');
  assert.equal(sessionCreates[0].sourceName, 'Email');
  assert.equal(sessionCreates[0].tool, 'claude');
  assert.equal(sessionCreates[0].name, 'hello!');
  assert.equal(sessionCreates[0].systemPrompt, 'Reply with plain text only.');
  assert.equal(sessionCreates[0].externalTriggerId, expectedThreadTriggerId);
  assert.equal(sessionCreates[0].completionTargets[0].inReplyTo, '<root-thread@example.com>');
  assert.equal(sessionCreates[0].completionTargets[0].references, '<root-thread@example.com>');
  assert.equal(sessionCreates[0].completionTargets[0].subject, 'Re: hello!');
  assert.match(messageSubmissions[0].text, /please take a response to test!/);
  assert.match(messageSubmissions[0].text, /^Inbound email\./);
  assert.match(messageSubmissions[0].text, /User message:/);
  assert.doesNotMatch(messageSubmissions[0].text, /Prefer completeness, careful troubleshooting/);
  assert.equal(messageSubmissions[0].tool, 'claude');
  assert.equal(messageSubmissions[0].model, 'claude-sonnet-4-5');
  assert.equal(messageSubmissions[0].thinking, true);
  assert.equal(messageSubmissions[0].effort, undefined);

  const updated = (await findQueueItem(approved.id, mailboxRoot))?.item;
  assert.equal(updated?.status, 'processing_for_reply');
  assert.equal(updated?.automation?.status, 'processing_for_reply');
  assert.equal(updated?.automation?.sessionId, 'sess_1');
  assert.equal(updated?.automation?.runId, 'run_1');

  const followUpIngested = await ingestRawMessage(
    [
      'From: owner@example.com',
      'To: rowan@example.com',
      'Subject: Re: hello!',
      'Message-ID: <follow-up@example.com>',
      'In-Reply-To: <root-thread@example.com>',
      'References: <root-thread@example.com>',
      'Content-Type: text/plain; charset=UTF-8',
      '',
      'here is the follow-up reply in the same thread.',
      '',
      'On Tue, Mar 10, 2026 at 9:56 PM <rowan@example.com> wrote:',
      '> please take a response to test!',
      '>',
      '> Rowan',
    ].join('\n'),
    'follow-up.eml',
    mailboxRoot,
    {
      text: [
        'here is the follow-up reply in the same thread.',
        '',
        'On Tue, Mar 10, 2026 at 9:56 PM <rowan@example.com> wrote:',
        '> please take a response to test!',
        '>',
        '> Rowan',
      ].join('\n'),
    },
  );
  const approvedFollowUp = (await findQueueItem(followUpIngested.id, mailboxRoot))?.item;
  assert.equal(approvedFollowUp?.queue, 'approved');
  assert.equal(approvedFollowUp?.review?.status, 'auto_approved');

  await saveUiRuntimeSelection({
    selectedTool: 'codex',
    selectedModel: 'gpt-5-codex',
    selectedEffort: 'high',
    reasoningKind: 'enum',
  });

  const secondWorker = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(repoRoot, 'scripts', 'agent-mail-worker.mjs'), '--once', '--root', mailboxRoot], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
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
        reject(new Error(stderr || `worker exited with ${code}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });

  const secondSummary = JSON.parse(secondWorker.stdout);
  assert.equal(secondSummary.processed, 1);
  assert.equal(secondSummary.failures.length, 0);
  assert.equal(requests.length, 6);
  assert.equal(sessionCreates.length, 2);
  assert.equal(messageSubmissions.length, 2);
  assert.equal(sessionCreates[1].tool, 'codex');
  assert.equal(sessionCreates[1].externalTriggerId, expectedThreadTriggerId);
  assert.equal(sessionCreates[1].completionTargets[0].inReplyTo, '<follow-up@example.com>');
  assert.equal(sessionCreates[1].completionTargets[0].references, '<root-thread@example.com> <follow-up@example.com>');
  assert.match(messageSubmissions[1].text, /here is the follow-up reply in the same thread\./);
  assert.doesNotMatch(messageSubmissions[1].text, /On Tue, Mar 10, 2026 at 9:56 PM <rowan@example\.com> wrote:/);
  assert.doesNotMatch(messageSubmissions[1].text, /^> please take a response to test!$/m);
  assert.equal(messageSubmissions[1].tool, 'codex');
  assert.equal(messageSubmissions[1].model, 'gpt-5-codex');
  assert.equal(messageSubmissions[1].effort, 'high');
  assert.equal(messageSubmissions[1].thinking, undefined);

  const updatedFollowUp = (await findQueueItem(approvedFollowUp.id, mailboxRoot))?.item;
  assert.equal(updatedFollowUp?.status, 'processing_for_reply');
  assert.equal(updatedFollowUp?.automation?.status, 'processing_for_reply');
  assert.equal(updatedFollowUp?.automation?.sessionId, 'sess_1');
  assert.equal(updatedFollowUp?.automation?.runId, 'run_2');

  const decodedChineseBody = '这一次请完整的回复我这一轮对话给你发送的消息，不要带其他内容。';
  const encodedChineseBody = Buffer.from(decodedChineseBody, 'utf8').toString('base64');
  const base64Ingested = await ingestRawMessage(
    [
      'From: owner@example.com',
      'To: rowan@example.com',
      'Subject: Re: hello!',
      'Message-ID: <base64-follow-up@example.com>',
      'In-Reply-To: <root-thread@example.com>',
      'References: <root-thread@example.com>',
      'Content-Type: multipart/alternative; boundary="gmail-boundary"',
      '',
      '--gmail-boundary',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      encodedChineseBody,
      '--gmail-boundary',
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      '<div>=E8=BF=99=E4=B8=80=E6=AC=A1=E8=AF=B7=E5=AE=8C=E6=95=B4=E7=9A=84=E5=9B=9E=E5=A4=8D=E6=88=91=E8=BF=99=E4=B8=80=E8=BD=AE=E5=AF=B9=E8=AF=9D=E7=BB=99=E4=BD=A0=E5=8F=91=E9=80=81=E7=9A=84=E6=B6=88=E6=81=AF=EF=BC=8C=E4=B8=8D=E8=A6=81=E5=B8=A6=E5=85=B6=E4=BB=96=E5=86=85=E5=AE=B9=E3=80=82</div>',
      '--gmail-boundary--',
    ].join('\n'),
    'base64-follow-up.eml',
    mailboxRoot,
  );
  const approvedBase64 = (await findQueueItem(base64Ingested.id, mailboxRoot))?.item;
  assert.equal(approvedBase64?.queue, 'approved');
  assert.equal(approvedBase64?.review?.status, 'auto_approved');

  const approvedBase64Path = join(mailboxPaths(mailboxRoot).approvedDir, `${approvedBase64.id}.json`);
  const legacyStoredBase64 = JSON.parse(readFileSync(approvedBase64Path, 'utf8'));
  legacyStoredBase64.content.extractedText = encodedChineseBody;
  legacyStoredBase64.content.preview = encodedChineseBody;
  delete legacyStoredBase64.message.headers['content-transfer-encoding'];
  writeFileSync(approvedBase64Path, JSON.stringify(legacyStoredBase64, null, 2));

  const thirdWorker = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(repoRoot, 'scripts', 'agent-mail-worker.mjs'), '--once', '--root', mailboxRoot], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
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
        reject(new Error(stderr || `worker exited with ${code}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });

  const thirdSummary = JSON.parse(thirdWorker.stdout);
  assert.equal(thirdSummary.processed, 1);
  assert.equal(thirdSummary.failures.length, 0);
  assert.equal(requests.length, 9);
  assert.equal(sessionCreates.length, 3);
  assert.equal(messageSubmissions.length, 3);
  assert.equal(sessionCreates[2].externalTriggerId, expectedThreadTriggerId);
  assert.equal(sessionCreates[2].completionTargets[0].inReplyTo, '<base64-follow-up@example.com>');
  assert.equal(sessionCreates[2].completionTargets[0].references, '<root-thread@example.com> <base64-follow-up@example.com>');
  assert.match(messageSubmissions[2].text, /这一次请完整的回复我这一轮对话给你发送的消息/);
  assert.ok(!messageSubmissions[2].text.includes(encodedChineseBody), 'worker prompt should decode legacy base64 mailbox content');

  const updatedBase64 = (await findQueueItem(approvedBase64.id, mailboxRoot))?.item;
  assert.equal(updatedBase64?.status, 'processing_for_reply');
  assert.equal(updatedBase64?.automation?.status, 'processing_for_reply');
  assert.equal(updatedBase64?.automation?.sessionId, 'sess_1');
  assert.equal(updatedBase64?.automation?.runId, 'run_3');

  const blankSubjectIngested = await ingestRawMessage(
    [
      'From: owner@example.com',
      'To: rowan@example.com',
      'Message-ID: <blank-subject-thread@example.com>',
      'Content-Type: text/plain; charset=UTF-8',
      '',
      'empty subject should still stay in the same thread.',
    ].join('\n'),
    'blank-subject.eml',
    mailboxRoot,
    { text: 'empty subject should still stay in the same thread.' },
  );
  const approvedBlankSubject = (await findQueueItem(blankSubjectIngested.id, mailboxRoot))?.item;
  assert.equal(approvedBlankSubject?.queue, 'approved');

  const fourthWorker = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(repoRoot, 'scripts', 'agent-mail-worker.mjs'), '--once', '--root', mailboxRoot], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
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
        reject(new Error(stderr || `worker exited with ${code}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });

  const fourthSummary = JSON.parse(fourthWorker.stdout);
  assert.equal(fourthSummary.processed, 1);
  assert.equal(fourthSummary.failures.length, 0);
  assert.equal(sessionCreates.length, 4);
  assert.equal(messageSubmissions.length, 4);
  assert.ok(!Object.hasOwn(sessionCreates[3], 'name'), 'blank-subject threads should not force a session name');
  assert.equal(sessionCreates[3].completionTargets[0].inReplyTo, '<blank-subject-thread@example.com>');
  assert.equal(sessionCreates[3].completionTargets[0].references, '<blank-subject-thread@example.com>');
  assert.equal(sessionCreates[3].completionTargets[0].subject, '', 'blank-subject replies should preserve an empty subject');

  const inlinePngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2lmLcAAAAASUVORK5CYII=';
  const imageIngested = await ingestRawMessage(
    [
      'From: owner@example.com',
      'To: rowan@example.com',
      'Subject: Screenshot included',
      'Message-ID: <image-thread@example.com>',
      'Content-Type: multipart/mixed; boundary="image-boundary"',
      '',
      '--image-boundary',
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      'please inspect the attached screenshot.',
      '--image-boundary',
      'Content-Type: image/png; name="mail-shot.png"',
      'Content-Transfer-Encoding: base64',
      'Content-Disposition: attachment; filename="mail-shot.png"',
      '',
      inlinePngBase64,
      '--image-boundary--',
    ].join('\n'),
    'image-thread.eml',
    mailboxRoot,
  );
  const approvedImage = (await findQueueItem(imageIngested.id, mailboxRoot))?.item;
  assert.equal(approvedImage?.queue, 'approved');
  assert.equal(approvedImage?.content?.images?.length, 1);
  assert.equal(approvedImage?.content?.images?.[0]?.originalName, 'mail-shot.png');

  const fifthWorker = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(repoRoot, 'scripts', 'agent-mail-worker.mjs'), '--once', '--root', mailboxRoot], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
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
        reject(new Error(stderr || `worker exited with ${code}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });

  const fifthSummary = JSON.parse(fifthWorker.stdout);
  assert.equal(fifthSummary.processed, 1);
  assert.equal(fifthSummary.failures.length, 0);
  assert.equal(sessionCreates.length, 5);
  assert.equal(messageSubmissions.length, 5);
  assert.equal(messageSubmissions[4].attachments?.length, 1);
  assert.equal(messageSubmissions[4].attachments[0].mimeType, 'image/png');
  assert.equal(messageSubmissions[4].attachments[0].originalName, 'mail-shot.png');
  assert.equal(messageSubmissions[4].attachments[0].data, inlinePngBase64);

  const updatedImage = (await findQueueItem(approvedImage.id, mailboxRoot))?.item;
  assert.equal(updatedImage?.status, 'processing_for_reply');
  assert.equal(updatedImage?.automation?.status, 'processing_for_reply');

  const pdfBase64 = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'utf8').toString('base64');
  const pdfIngested = await ingestRawMessage(
    [
      'From: owner@example.com',
      'To: rowan@example.com',
      'Subject: PDF included',
      'Message-ID: <pdf-thread@example.com>',
      'Content-Type: multipart/mixed; boundary="pdf-boundary"',
      '',
      '--pdf-boundary',
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      'please inspect the attached pdf.',
      '--pdf-boundary',
      'Content-Type: application/pdf; name="spec.pdf"',
      'Content-Transfer-Encoding: base64',
      'Content-Disposition: attachment; filename="spec.pdf"',
      '',
      pdfBase64,
      '--pdf-boundary--',
    ].join('\n'),
    'pdf-thread.eml',
    mailboxRoot,
  );
  const approvedPdf = (await findQueueItem(pdfIngested.id, mailboxRoot))?.item;
  assert.equal(approvedPdf?.queue, 'approved');
  assert.equal(approvedPdf?.content?.attachments?.length, 1);
  assert.equal(approvedPdf?.content?.attachments?.[0]?.mimeType, 'application/pdf');
  assert.equal(approvedPdf?.content?.attachments?.[0]?.originalName, 'spec.pdf');

  const sixthWorker = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(repoRoot, 'scripts', 'agent-mail-worker.mjs'), '--once', '--root', mailboxRoot], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
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
        reject(new Error(stderr || `worker exited with ${code}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });

  const sixthSummary = JSON.parse(sixthWorker.stdout);
  assert.equal(sixthSummary.processed, 1);
  assert.equal(sixthSummary.failures.length, 0);
  assert.equal(sessionCreates.length, 6);
  assert.equal(messageSubmissions.length, 6);
  assert.equal(messageSubmissions[5].attachments?.length, 1);
  assert.equal(messageSubmissions[5].attachments[0].mimeType, 'application/pdf');
  assert.equal(messageSubmissions[5].attachments[0].originalName, 'spec.pdf');
  assert.equal(messageSubmissions[5].attachments[0].data, pdfBase64);

  const updatedPdf = (await findQueueItem(approvedPdf.id, mailboxRoot))?.item;
  assert.equal(updatedPdf?.status, 'processing_for_reply');
  assert.equal(updatedPdf?.automation?.status, 'processing_for_reply');

  requests.length = 0;
  sessionCreates.length = 0;
  messageSubmissions.length = 0;

  const guestAuthDir = join(tempHome, '.remotelab', 'instances', 'trial6', 'config');
  const guestAuthFile = join(guestAuthDir, 'auth.json');
  mkdirSync(guestAuthDir, { recursive: true });
  writeFileSync(guestAuthFile, JSON.stringify({
    token: 'trial6-auth-token',
  }, null, 2));
  writeFileSync(join(tempHome, '.config', 'remotelab', 'guest-instances.json'), JSON.stringify([
    {
      name: 'trial6',
      authFile: guestAuthFile,
      localBaseUrl: `http://127.0.0.1:${port}`,
    },
  ], null, 2));

  await saveMailboxAutomation(mailboxRoot, {
    allowlistAutoApprove: true,
    chatBaseUrl: 'http://127.0.0.1:7690',
    deliveryMode: 'session_only',
    session: {
      folder: '~',
      tool: 'codex',
      group: 'Mail',
      description: 'Inbound email',
      systemPrompt: '',
    },
  });

  const routedIngested = await ingestRawMessage(
    [
      'From: owner@example.com',
      'To: rowan@example.com',
      'Subject: route to trial6',
      'Message-ID: <trial6-session@example.com>',
      'Content-Type: text/plain; charset=UTF-8',
      '',
      'this should create a session in trial6 without an email reply.',
    ].join('\n'),
    'trial6-session.eml',
    mailboxRoot,
    {
      text: 'this should create a session in trial6 without an email reply.',
      envelope: {
        rcptTo: 'rowan+trial6@example.com',
      },
    },
  );
  const approvedRouted = (await findQueueItem(routedIngested.id, mailboxRoot))?.item;
  assert.equal(approvedRouted?.routing?.instanceName, 'trial6');

  const sessionOnlyWorker = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(repoRoot, 'scripts', 'agent-mail-worker.mjs'), '--once', '--root', mailboxRoot], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
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
        reject(new Error(stderr || `worker exited with ${code}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });

  const sessionOnlySummary = JSON.parse(sessionOnlyWorker.stdout);
  assert.equal(sessionOnlySummary.processed, 1);
  assert.equal(sessionOnlySummary.failures.length, 0);
  assert.equal(requests.length, 3);
  assert.equal(sessionCreates.length, 1);
  assert.equal(messageSubmissions.length, 1);
  assert.equal(sessionCreates[0].completionTargets, undefined);
  assert.equal(messageSubmissions[0].requestId.startsWith('mailbox_session_'), true);
  const loginRequest = requests.find((entry) => entry.method === 'GET' && entry.url.startsWith('/?token='));
  assert.equal(new URL(loginRequest.url, 'http://127.0.0.1').searchParams.get('token'), 'trial6-auth-token');

  const updatedRouted = (await findQueueItem(approvedRouted.id, mailboxRoot))?.item;
  assert.equal(updatedRouted?.status, 'submitted_to_session');
  assert.equal(updatedRouted?.automation?.status, 'submitted_to_session');
  assert.equal(updatedRouted?.automation?.targetInstance, 'trial6');
  assert.equal(updatedRouted?.automation?.targetBaseUrl, `http://127.0.0.1:${port}`);

  requests.length = 0;
  sessionCreates.length = 0;
  messageSubmissions.length = 0;

  const localPartMailboxRoot = join(tempHome, '.config', 'remotelab', 'agent-mailbox-local-part');
  await initializeMailbox({
    rootDir: localPartMailboxRoot,
    name: 'Rowan',
    localPart: 'rowan',
    domain: 'example.com',
    allowEmails: ['owner@example.com'],
    instanceAddressMode: 'local_part',
  });
  await saveMailboxAutomation(localPartMailboxRoot, {
    allowlistAutoApprove: true,
    chatBaseUrl: 'http://127.0.0.1:7690',
    deliveryMode: 'reply_email',
    session: {
      folder: '~',
      tool: 'codex',
      group: 'Mail',
      description: 'Inbound email',
      systemPrompt: '',
    },
  });

  const trial1AuthDir = join(tempHome, '.remotelab', 'instances', 'trial1', 'config');
  const trial1AuthFile = join(trial1AuthDir, 'auth.json');
  mkdirSync(trial1AuthDir, { recursive: true });
  writeFileSync(trial1AuthFile, JSON.stringify({
    token: 'trial1-auth-token',
  }, null, 2));
  writeFileSync(join(tempHome, '.config', 'remotelab', 'guest-instances.json'), JSON.stringify([
    {
      name: 'trial1',
      authFile: trial1AuthFile,
      localBaseUrl: `http://127.0.0.1:${port}`,
    },
  ], null, 2));

  const localPartIngested = await ingestRawMessage(
    [
      'From: owner@example.com',
      'To: rowan@example.com',
      'Subject: route to trial1 direct mailbox',
      'Message-ID: <trial1-direct@example.com>',
      'Content-Type: text/plain; charset=UTF-8',
      '',
      'this should reply from the direct trial1 address.',
    ].join('\n'),
    'trial1-direct.eml',
    localPartMailboxRoot,
    {
      text: 'this should reply from the direct trial1 address.',
      envelope: {
        rcptTo: 'trial1@example.com',
      },
    },
  );
  const approvedLocalPart = (await findQueueItem(localPartIngested.id, localPartMailboxRoot))?.item;
  assert.equal(approvedLocalPart?.routing?.instanceName, 'trial1');
  assert.equal(approvedLocalPart?.message?.effectiveToAddress, 'trial1@example.com');

  const localPartWorker = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(repoRoot, 'scripts', 'agent-mail-worker.mjs'), '--once', '--root', localPartMailboxRoot], {
      cwd: repoRoot,
      env: { ...process.env, HOME: tempHome },
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
        reject(new Error(stderr || `worker exited with ${code}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });

  const localPartSummary = JSON.parse(localPartWorker.stdout);
  assert.equal(localPartSummary.processed, 1);
  assert.equal(localPartSummary.failures.length, 0);
  assert.equal(requests.length, 3);
  assert.equal(sessionCreates.length, 1);
  assert.equal(messageSubmissions.length, 1);
  assert.equal(sessionCreates[0].completionTargets[0].from, 'trial1@example.com');
  const localPartLoginRequest = requests.find((entry) => entry.method === 'GET' && entry.url.startsWith('/?token='));
  assert.equal(new URL(localPartLoginRequest.url, 'http://127.0.0.1').searchParams.get('token'), 'trial1-auth-token');

  const updatedLocalPart = (await findQueueItem(approvedLocalPart.id, localPartMailboxRoot))?.item;
  assert.equal(updatedLocalPart?.status, 'processing_for_reply');
  assert.equal(updatedLocalPart?.automation?.status, 'processing_for_reply');
  assert.equal(updatedLocalPart?.automation?.targetInstance, 'trial1');
  assert.equal(updatedLocalPart?.automation?.targetBaseUrl, `http://127.0.0.1:${port}`);
} finally {
  server.close();
  rmSync(tempHome, { recursive: true, force: true });
}

console.log('agent mail worker tests passed');
