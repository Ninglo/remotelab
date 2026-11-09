import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { parse as parseUrl } from 'node:url';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const home = await mkdtemp(join(tmpdir(), 'parallel-display-'));
setIsolatedTestHome(home);
try {
  const { loadAuthDocument, findPerson } = await import('../lib/auth-config.mjs');
  const { loadParallelDisplayTrial, changeParallelDisplayTrial, captureParallelDisplayTrial,
    activePlanDisplay, parallelDisplayPrompt, branchDisplayName } = await import('../chat/parallel-display-trial.mjs');
  const people = ['a', 'b'].map(id => ({ id: 'person_' + id, name: id, handle: id, credentials: [],
      preferences: { messageReplies: { sentinel: id } },
      identities: [{ id: 'identity_' + id, kind: 'web', realm: 'test', subjectId: id }] }));
  await mkdir(join(home, '.config/remotelab'), { recursive: true });
  await writeFile(join(home, '.config/remotelab/auth.json'), JSON.stringify({ version: 2, primaryPersonId: 'person_a', people }));
  const actor = { personId: 'person_a', identityId: 'identity_a', authKind: 'accepted-run',
    sessionId: 'source', requestId: 'human-request' };
  assert.equal((await loadParallelDisplayTrial(actor)).active, false);
  await assert.rejects(changeParallelDisplayTrial({ enabled: true, expectedRevision: 0, confirm: true },
    { ...actor, identityId: 'identity_b' }), /本人/);
  const saved = await changeParallelDisplayTrial({ enabled: true, expectedRevision: 0, confirm: true, durationDays: 7 }, actor);
  assert.equal(Date.parse(saved.endsAt) - Date.parse(saved.startsAt), 7 * 86400000);
  const trial = await captureParallelDisplayTrial('person_a');
  assert(trial);
  assert.equal(await captureParallelDisplayTrial('person_b'), null);
  assert.equal(await captureParallelDisplayTrial('person_a', Date.parse(trial.endsAt)), null);
  assert.equal(await captureParallelDisplayTrial('person_a', Date.parse(trial.startsAt) - 1), null);
  assert.deepEqual(findPerson(await loadAuthDocument(), 'person_a').preferences.messageReplies, { sentinel: 'a' });
  const plan = { displayTrial: trial, actor, branches: [{ id: 'a', name: '调查' }, { id: 'b', name: '验证' }] };
  assert(await activePlanDisplay(plan));
  assert.equal(await activePlanDisplay({ ...plan, actor: { personId: 'person_b' } }), null);
  assert.equal(branchDisplayName(plan, plan.branches[1]), '分支 2｜验证');
  plan.branches[1].state = 'completed';
  assert.equal(branchDisplayName(plan, plan.branches[1]), '分支 2｜验证', 'completion order cannot renumber branches');
  assert.match(parallelDisplayPrompt(trial, plan), /主对话进展/);
  assert.match(parallelDisplayPrompt(trial, plan, plan.branches[1]), /分支 2｜验证进展/);
  assert.match(parallelDisplayPrompt(trial, plan), /待主对话验收/);
  await changeParallelDisplayTrial({ enabled: false, expectedRevision: saved.revision, confirm: true }, actor);
  assert.equal(await activePlanDisplay(plan), null, 'off disables new projections of the old plan');
  assert.equal(await captureParallelDisplayTrial('person_a'), null);
  assert.equal((await loadParallelDisplayTrial(actor)).endsAt, saved.endsAt, 'retain the observation window');
  await assert.rejects(changeParallelDisplayTrial({ enabled: true, expectedRevision: 0, confirm: true }, actor), /已变化/);
  const { requests } = await import('../chat/requests.mjs');
  const { handleMessageReplySettings } = await import('../chat/router-message-reply-settings.mjs');
  const { runMessageReplyCommand } = await import('../lib/message-reply-command.mjs');
  const record = (await requests.accept({ sessionId: 'source', requestId: 'display-api', text: '只为我试用七天',
    options: { viewPersonId: actor.personId, initiatedByIdentityId: actor.identityId } })).record;
  const client = { async request(url, options) {
    const parsedUrl = parseUrl(url, true);
    const req = Readable.from(options?.body ? [Buffer.from(JSON.stringify(options.body))] : []);
    req.method = options?.body ? 'POST' : 'GET';
    let response;
    await handleMessageReplySettings({ req, res: {}, pathname: parsedUrl.pathname, parsedUrl,
      authSession: { authKind: 'service' }, writeJson(_res, code, json) { response = { response: { ok: code === 200 }, json }; } });
    return response;
  } };
  let output;
  await runMessageReplyCommand(['parallel-display', 'on', '--days', '7', '--json'],
    { runId: record.runId, client, stdout: { write(value) { output = JSON.parse(value); } } });
  assert.equal(output.settings.active, true);
  assert.equal(output.settings.source.requestId, record.requestId);
  assert.equal(output.settings.personId, actor.personId);
  const forged = await client.request('/api/message-reply-settings/current-run', { body: { runId: record.runId,
    setting: 'parallel-display', enabled: true, personId: 'person_b', confirm: true, expectedRevision: output.settings.revision } });
  assert.equal(forged.response.ok, false);
  assert.equal(await captureParallelDisplayTrial('person_b'), null);
  console.log('PARALLEL_DISPLAY_VERIFIED: verified owner, untouched preferences, 7-day expiry, disable, stable branch labels and acceptance distinction.');
} finally { await rm(home, { recursive: true, force: true }); }
