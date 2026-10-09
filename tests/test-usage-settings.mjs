import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const home = await mkdtemp(join(tmpdir(), 'usage-settings-'));
setIsolatedTestHome(home);
after(() => rm(home, { recursive: true, force: true }));
const { CONFIG_DIR, CHAT_SESSIONS_FILE } = await import('../lib/config.mjs');
const { createSettingObserver, readSettingSnapshot } = await import('../lib/usage-setting-store.mjs');
const { settingRows, settingObserver, observeSettingRows, personSettingValues } = await import('../chat/usage-settings.mjs');
const { createUsageEventStore, usageEvents, usageKey, normalizeUsageEvent } = await import('../chat/usage-events.mjs');
const { changeMessageReplySettings, loadMessageReplySettings } = await import('../chat/message-reply-settings.mjs');
const { updateInstanceSettings } = await import('../chat/instance-settings.mjs');
const { updateVoiceReviewSettings } = await import('../chat/voice-review.mjs');
const { collectSettingBaseline } = await import('../chat/usage-setting-baseline.mjs');
const { handleUsageRoutes } = await import('../chat/router-usage-routes.mjs');
const { recordDisplayTheme, readDisplayThemeBaseline } = await import('../chat/display-theme-analytics.mjs');
const { createPerson, updatePerson, listPeopleForClient } = await import('../lib/auth.mjs');
const actor = { personId: 'private-person', identityId: 'private-identity' };
const rows = (value, browser = 'private-browser', personId = actor.personId) => settingRows({ 'web.theme': value }, {
  scope: 'browser', scopeId: `${personId}:${browser}`, authority: 'browser', subjectPersonId: personId,
});
const emitInto = store => pending => store.record(pending, { verifiedPersonHash: pending[0].personHash });

test('durable configuration state, retries and lost event acknowledgements preserve counts and privacy', async () => {
  const directory = join(home, 'durable'), settingsDirectory = join(directory, 'usage-settings');
  const ledger = createUsageEventStore({ directory: join(directory, 'usage-events'), loadSessionOrigins: async () => ({ origins: [], errors: 0 }) });
  let time = Date.now();
  const observer = createSettingObserver({ directory: settingsDirectory, now: () => ++time,
    emit: async pending => { await emitInto(ledger)(pending); return false; } });
  await observer.observe(rows('system'), { ...actor, operation: 'snapshot' });
  assert.equal((await observer.snapshot()).incomplete, true);
  const restarted = createSettingObserver({ directory: settingsDirectory, now: () => ++time, emit: emitInto(ledger) });
  await restarted.observe(rows('dark'), { ...actor, operation: 'change', operationId: 'dark-operation' });
  await restarted.observe(rows('system'), { ...actor, operation: 'change', operationId: 'system-operation' });
  await restarted.observe(rows('dark'), { ...actor, operation: 'change', operationId: 'dark-operation' });
  await restarted.observe(rows('system'), { ...actor, operation: 'change' });
  await restarted.observe(rows('light', 'second-browser'), { ...actor, operation: 'snapshot' });
  await restarted.observe(rows('amber', 'private-browser', 'another-person'), { personId: 'another-person', operation: 'snapshot' });
  const snapshot = await restarted.snapshot();
  assert.equal(snapshot.incomplete, false); assert.equal(Object.keys(snapshot.rows).length, 3);
  const x = await ledger.query({ limit: 1, sessionId: 'irrelevant', settingSnapshot: snapshot });
  assert.equal(x.events.length, 0, 'configuration history is instance-wide even with a Session filter');
  const theme = x.report.settings.rows.find(row => row.setting === 'web.theme');
  assert.equal(theme.configurations, 3); assert.equal(theme.subjects, 2);
  assert.equal(theme.changes, 2); assert.equal(theme.restoredDefaults, 1); assert.equal(theme.returnsToEarlier, 1);
  assert.equal(x.report.activity.people, 0); assert.equal(x.report.settings.partial, false);
  const logs = (await ledger.query()).events;
  assert.equal(logs.filter(event => event.event === 'setting_state').length, 5, 'restart replay and repeated saves do not inflate history');
  const raw = JSON.stringify({ snapshot, logs });
  assert.doesNotMatch(raw, /private-person|private-identity|private-browser|another-person/);
  assert.equal((await stat(join(settingsDirectory, 'current.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(settingsDirectory)).mode & 0o777, 0o700);
});

test('stale snapshots, corrupt state and bounded outboxes cannot overwrite current observations or imply complete coverage', async () => {
  const directory = join(home, 'stale');
  const observer = createSettingObserver({ directory, now: () => Date.now(), emit: async () => false, maxPending: 1 });
  await observer.observe(rows('dark'), { observedAt: 2000 });
  await observer.observe(rows('light'), { observedAt: 1000 });
  assert.equal(Object.values((await observer.snapshot()).rows)[0].value, 'dark');
  await observer.observe(rows('amber'), { operation: 'change', observedAt: 3000 });
  await observer.observe(rows('dark'), { operation: 'snapshot', observedAt: 3000 });
  assert.equal(Object.values((await observer.snapshot()).rows)[0].value, 'amber', 'an equal-time stale baseline cannot reverse a confirmed save');
  assert.equal((await observer.snapshot()).incomplete, true);
  await writeFile(join(directory, 'current.json'), 'damaged');
  assert.equal(await observer.observe(rows('system')), false);
  assert.equal(await readFile(join(directory, 'current.json'), 'utf8'), 'damaged', 'do not overwrite unreadable evidence');
  assert.equal((await readSettingSnapshot(directory)).incomplete, true);
  const recovered = createSettingObserver({ directory, emit: async () => true });
  await writeFile(join(directory, 'current.json'), JSON.stringify({ version: 1, revision: 0, rows: {}, pending: [] }));
  await recovered.observe(rows('system'));
  assert.equal((await recovered.snapshot()).incomplete, true, 'a known storage failure remains visible across recovery and restart');
});

test('reply drafts, actual group activation, no-op saves and restoring defaults remain distinct', async () => {
  const groups = [{ sourceRouteId: 'bot', chatId: 'oc_first' }, { sourceRouteId: 'bot', chatId: 'oc_second' }];
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CHAT_SESSIONS_FILE, JSON.stringify(groups.map((group, n) => ({ id: 'group-' + n,
    conversation: { connector: 'feishu', sourceRouteId: group.sourceRouteId, target: { chatType: 'group', chatId: group.chatId } } }))));
  await collectSettingBaseline();
  let settings = await loadMessageReplySettings();
  const draft = { opening: false, checklist: false, progress: 'card_all', groups: [groups[0]] };
  settings = await changeMessageReplySettings({ action: 'draft', expectedRevision: settings.revision, draft }, actor);
  let result = await usageEvents.query({ settingSnapshot: await settingObserver.snapshot() });
  assert.equal(result.report.settings.rows.find(row => row.setting === 'reply.mode' && row.stage === 'applied').changes, 0);
  assert.ok(result.report.settings.rows.find(row => row.setting === 'reply.progress' && row.stage === 'draft').changes > 0);
  const total = result.total;
  await assert.rejects(changeMessageReplySettings({ action: 'activate', expectedRevision: settings.revision }, actor), /确认/);
  assert.equal((await usageEvents.query()).total, total, 'failed confirmation records no applied choice');
  settings = await changeMessageReplySettings({ action: 'activate', expectedRevision: settings.revision, confirm: true }, actor);
  settings = await changeMessageReplySettings({ action: 'activate', expectedRevision: settings.revision, confirm: true }, actor);
  result = await usageEvents.query({ settingSnapshot: await settingObserver.snapshot() });
  const mode = result.report.settings.rows.find(row => row.setting === 'reply.mode' && row.stage === 'applied');
  assert.equal(mode.changes, 1); assert.equal(mode.configurations, 2); assert.equal(mode.actors, 1);
  assert.equal(mode.values.find(value => value.value === 'custom').configurations, 1);
  settings = await changeMessageReplySettings({ action: 'legacy', expectedRevision: settings.revision, confirm: true }, actor);
  await changeMessageReplySettings({ action: 'legacy', expectedRevision: settings.revision, confirm: true }, actor);
  result = await usageEvents.query({ settingSnapshot: await settingObserver.snapshot() });
  const restored = result.report.settings.rows.find(row => row.setting === 'reply.mode' && row.stage === 'applied');
  assert.equal(restored.changes, 2); assert.equal(restored.restoredDefaults, 1); assert.equal(restored.returnsToEarlier, 1);
  assert.equal(restored.values.find(value => value.value === 'default').configurations, 2);
  assert.doesNotMatch(JSON.stringify(result), /oc_first|oc_second|private-person|private-identity/);
});

test('successful instance and personal saves emit only supported choices; observer failure never rejects the actual save', async () => {
  await updateInstanceSettings({ sessionAutoArchive: { enabled: true }, voiceInput: { accessToken: 'secret-token', appId: 'private-app' } }, actor);
  await updateInstanceSettings({ sessionAutoArchive: { enabled: true } }, actor);
  await updateVoiceReviewSettings(actor.personId, { enabled: true, reviewMode: 'model', providerId: 'doubao',
    apiKey: 'private-api-key', terms: ['private-term => private-correction'] }, actor);
  const person = await createPerson({ name: 'Fixture', handle: 'fixture' });
  const personId = person.personId;
  await updatePerson(personId, { mobileInputMode: 'voice', quickLinks: [{ label: 'private-link-label', url: 'https://private.example/' }] }, {
    afterSave: saved => observeSettingRows(settingRows(personSettingValues(saved.after), { scope: 'person', scopeId: saved.personId,
      subjectPersonId: saved.personId, before: personSettingValues(saved.before) }), { ...actor, operation: 'change' }),
  });
  await updatePerson(personId, { mobileInputMode: 'text' }, { afterSave: () => { throw Error('observer error'); } });
  assert.equal((await listPeopleForClient()).find(person => person.id === personId).preferences.mobileInputMode, 'text');
  let x = await usageEvents.query({ settingSnapshot: await settingObserver.snapshot() });
  assert.equal(x.report.settings.rows.find(row => row.setting === 'instance.auto_archive').changes, 1);
  assert.equal(x.report.settings.rows.find(row => row.setting === 'person.mobile_input').changes, 1);
  assert.doesNotMatch(JSON.stringify(x), /secret-token|private-app|private-api-key|private-term|private-correction|private-link-label|private\.example/);
  const stateFile = join(CONFIG_DIR, 'usage-settings/current.json'), original = await readFile(stateFile, 'utf8');
  await writeFile(stateFile, 'invalid');
  const saved = await updateInstanceSettings({ sessionAutoArchive: { enabled: false } }, actor);
  assert.equal(saved.sessionAutoArchive.enabled, false, 'corrupt observation state cannot reject an authorized setting save');
  assert.equal((await settingObserver.snapshot()).writerFailed, true);
  await writeFile(stateFile, original);
});

async function settingRequest(input, authSession = actor) {
  let result;
  await handleUsageRoutes({ req: Object.assign(Readable.from([JSON.stringify(input)]), { method: 'POST', headers: {} }), res: {},
    pathname: '/api/usage/settings', parsedUrl: { query: {} }, authSession, writeJson: (_res, status, json) => { result = { status, json }; } });
  return result;
}

test('display preview and applied themes stay separate; legacy choices seed state without inventing adoption', async () => {
  const person = await createPerson({ name: 'Display fixture', handle: 'display-fixture' });
  await recordDisplayTheme({ personId: person.personId, theme: 'rose', action: 'selected' });
  await recordDisplayTheme({ personId: person.personId, theme: 'classic', action: 'applied' });
  await recordDisplayTheme({ personId: person.personId, theme: 'mint', action: 'applied' });
  const legacy = await readDisplayThemeBaseline(await listPeopleForClient());
  assert.equal(legacy.incomplete, false);
  assert.equal(legacy.rows.find(row => row.stage === 'preview').value, 'rose');
  assert.equal(legacy.rows.find(row => row.stage === 'applied').value, 'mint');
  const baselineEvents = [];
  const legacyObserver = createSettingObserver({ directory: join(home, 'display-baseline'), emit: async events => { baselineEvents.push(...events); return true; } });
  await legacyObserver.observe(legacy.rows, { operation: 'snapshot' });
  assert.ok(baselineEvents.every(event => event.operation === 'snapshot'), 'legacy previews are baselines, not new preview selections');
  const x = await usageEvents.query({ settingSnapshot: await settingObserver.snapshot() });
  assert.equal(x.report.settings.rows.find(row => row.setting === 'display.theme' && row.stage === 'preview').previews, 1);
  assert.equal(x.report.settings.rows.find(row => row.setting === 'display.theme' && row.stage === 'applied').changes, 1);
});

test('browser settings authenticate attribution, cannot forge server settings, and deduplicate reload retries', async () => {
  const base = { browserId: randomUUID(), observationId: randomUUID(), timestamp: Date.now(), operation: 'snapshot', values: { 'web.theme': 'system' } };
  assert.equal((await settingRequest(base, null)).status, 403);
  assert.equal((await settingRequest(base, { ...actor, authKind: 'service' })).status, 403);
  assert.equal((await settingRequest({ ...base, values: { 'reply.mode': 'custom' } })).status, 400);
  assert.equal((await settingRequest({ ...base, values: { 'web.theme': 'custom-secret-json' } })).status, 400);
  assert.equal((await settingRequest({ ...base, observationId: randomUUID(), values: { 'web.language': 'zh-CN' } })).status, 202);
  assert.equal((await settingRequest({ ...base, personId: 'forged', scopeKey: 'forged' })).status, 202);
  const change = { ...base, observationId: randomUUID(), timestamp: Date.now(), operation: 'change', values: { 'web.theme': 'dark' } };
  assert.equal((await settingRequest(change)).status, 202);
  assert.equal((await settingRequest(change)).status, 202);
  const x = await usageEvents.query({ settingSnapshot: await settingObserver.snapshot() });
  const theme = x.report.settings.rows.find(row => row.setting === 'web.theme');
  assert.equal(theme.changes, 1); assert.equal(theme.subjects, 1);
  const state = x.events.find(event => event.setting === 'web.theme');
  assert.equal(state.personHash, usageKey(`person:${actor.personId}`));
  assert.equal(state.subjectHash, state.personHash); assert.equal(state.authority, 'browser');
  assert.equal(normalizeUsageEvent({ ...state, eventId: 'forged-client' }, { client: true }), null);
  assert.equal(normalizeUsageEvent({ ...state, settingValue: 'secret' }), null);
  assert.equal(JSON.stringify(x).includes(base.browserId), false);
});
