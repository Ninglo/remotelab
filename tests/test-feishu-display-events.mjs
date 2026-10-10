import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFeishuDisplayEventWriter, feishuDisplayEventDirectory, watchFeishuDisplayEvents } from '../lib/feishu-display-events.mjs';

const directory = await mkdtemp(join(tmpdir(), 'display-events-'));
let watcher;
try {
  let clock = 1000;
  const write = createFeishuDisplayEventWriter({ configDir: directory, realm: 'bot-2', now: () => clock });
  const event = { header: { event_id: 'private-event-id' }, event: { message: {
    message_id: 'private-message-id', content: 'private-body', mentions: [{ name: 'private-name' }] } } };
  assert.equal(await write('im.message.receive_v1', event), true);
  assert.equal(await write('im.message.receive_v1', event), false, 'duplicate delivery creates no new hint');
  const file = join(feishuDisplayEventDirectory(directory), 'bot-2.json');
  const first = JSON.parse(await readFile(file, 'utf8'));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(feishuDisplayEventDirectory(directory))).mode & 0o777, 0o700);
  assert.equal(first.messages.changedAt, clock);
  assert(!JSON.stringify(first).includes('private-'), 'the bridge contains no message data or raw event IDs');
  const restartedWriter = createFeishuDisplayEventWriter({ configDir: directory, realm: 'bot-2', now: () => ++clock });
  assert.equal(await restartedWriter('im.message.receive_v1', event), false, 'deduplication survives a connector restart');
  assert.equal(await write('unknown-event', event), false);
  assert.equal(await write('im.message.receive_v1', {}), false, 'a hint requires a real event identity');
  const changes = [];
  let onNext;
  watcher = await watchFeishuDisplayEvents({ configDir: directory, onChange: async (realm, change) => {
    changes.push({ realm, change });
    onNext?.();
  } });
  assert.equal(changes.length, 1, 'startup reads durable hints once without a provider request');
  const changed = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('File event did not arrive')), 3000);
    onNext = () => { clearTimeout(deadline); resolve(); };
  });
  clock += 100;
  await write('calendar.calendar.event.changed_v4', { event_id: 'calendar-event',
    user_id_list: [{ open_id: 'ou_calendar_owner' }], calendar_id: 'private-calendar' });
  await changed;
  await watcher.idle();
  const key = createHash('sha256').update('bot-2:ou_calendar_owner').digest('hex');
  assert.equal(changes.at(-1).realm, 'bot-2');
  assert.equal(changes.at(-1).change.calendar.subjects[key], clock, 'calendar hints retain their recipient boundary');
  assert(!changes.at(-1).change.messages, 'a calendar event never dirties message data');
  assert.equal(changes.at(-1).change.calendar.everyoneAt, 0);
  const read = JSON.parse(await readFile(file, 'utf8'));
  assert(!JSON.stringify(read).match(/private-|ou_calendar_owner/));
  assert.equal(changes.length, 2, 'atomic rename notifications are coalesced without duplicate delivery');
  console.log('ok - durable private Feishu change hints, recipient scope, deduplication, and native file events');
} finally { watcher?.stop(); await rm(directory, { recursive: true, force: true }); }
