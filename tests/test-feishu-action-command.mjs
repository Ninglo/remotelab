import assert from 'node:assert/strict';
import { parseFeishuActionArgs, planFeishuAction, runFeishuActionCommand } from '../lib/feishu-action-command.mjs';

const profile = 'bot-2';
const userId = 'ou_aa8d25de31a3f100e2f9299aba00f6ea';
const messageId = 'om_x100b648237b0bca0c2cc19fd694d011';

assert.deepEqual(parseFeishuActionArgs(['base.records', '--profile', profile, '--field', 'Name', '--field', 'Status']), {
  action: 'base.records', options: { profile, field: ['Name', 'Status'] },
});

const card = planFeishuAction('card.send', {
  profile, 'user-id': userId, title: 'Ready', body: 'The task is done', status: 'success', key: 'card-run-123',
});
assert.equal(card.args.at(-2), '--as');
assert.equal(card.args.at(-1), 'bot');
assert.equal(card.args[card.args.indexOf('--msg-type') + 1], 'interactive');
const cardJson = JSON.parse(card.args[card.args.indexOf('--content') + 1]);
assert.equal(cardJson.header.template, 'green');
assert.equal(cardJson.header.title.content, 'Ready');
assert.equal(cardJson.elements[0].text.content, 'The task is done');
assert.ok(!card.args.includes('user'));

assert.throws(() => planFeishuAction('card.send', { profile, 'user-id': userId, 'chat-id': 'oc_abc',
  title: 'Test', body: 'Body', key: 'card-run-123' }), /exactly one/);
assert.throws(() => planFeishuAction('message.send', { profile, 'user-id': userId, text: 'Hi' }), /--key is required/);
assert.throws(() => planFeishuAction('contact.get', { profile, 'user-id': userId, text: 'ignored' }), /not used/);
assert.throws(() => parseFeishuActionArgs(['contact.get', '--as', 'user']), /Unknown option/);
assert.throws(() => planFeishuAction('calendar.create', { profile, 'calendar-id': 'cal', summary: 'Test',
  start: '2026-09-29T09:00:00', end: '2026-09-29T10:00:00+08:00' }), /timezone/);
assert.throws(() => planFeishuAction('calendar.create', { profile, 'calendar-id': 'cal', summary: 'Test',
  start: '2026-09-29T10:00:00+08:00', end: '2026-09-29T09:00:00+08:00' }), /later/);
assert.throws(() => planFeishuAction('base.records', { profile, 'base-token': 'app123', 'table-id': 'tbl123' }), /--field/);

const base = planFeishuAction('base.records', {
  profile, 'base-token': 'app123', 'table-id': 'tbl123', field: ['Name', 'Status'], limit: '5',
});
assert.deepEqual(base.args.filter((item) => item === '--field-id'), ['--field-id', '--field-id']);
assert.equal(base.args[base.args.indexOf('--limit') + 1], '5');

function captureIo() {
  let output = '';
  let error = '';
  return {
    io: { stdout: { write(value) { output += value; } }, stderr: { write(value) { error += value; } } },
    get output() { return output; },
    get error() { return error; },
  };
}

const sent = captureIo();
const calls = [];
const sendStatus = await runFeishuActionCommand([
  'card.send', '--profile', profile, '--user-id', userId,
  '--title', 'Status', '--body', 'Ready', '--key', 'card-run-124',
], sent.io, async (_path, args) => {
  calls.push(args);
  return args.includes('+messages-send')
    ? { stdout: JSON.stringify({ ok: true, message_id: messageId, chat_id: 'oc_abc' }) }
    : { stdout: JSON.stringify({ ok: true, messages: [{ message_id: messageId, msg_type: 'interactive' }] }) };
});
assert.equal(sendStatus, 0);
assert.equal(calls.length, 2);
assert.equal(calls[1][calls[1].indexOf('--no-reactions')], '--no-reactions');
assert.deepEqual(JSON.parse(sent.output), {
  action: 'card.send', ok: true, message_id: messageId, chat_id: 'oc_abc', confirmed: true,
});

const failedReadback = captureIo();
const failStatus = await runFeishuActionCommand([
  'message.send', '--profile', profile, '--user-id', userId, '--text', 'Hi', '--key', 'message-run-1',
], failedReadback.io, async (_path, args) => args.includes('+messages-send')
  ? { stdout: JSON.stringify({ ok: true, message_id: messageId }) }
  : Promise.reject(new Error('readback unavailable')));
assert.equal(failStatus, 0);
assert.equal(JSON.parse(failedReadback.output).confirmed, false);
assert.equal(JSON.parse(failedReadback.output).message_id, messageId);

const rejected = captureIo();
const rejectedStatus = await runFeishuActionCommand(['contact.get', '--profile', profile, '--user-id', userId],
  rejected.io, async () => ({ stdout: JSON.stringify({ ok: false, error: { message: 'missing scope' } }) }));
assert.equal(rejectedStatus, 1);
assert.equal(JSON.parse(rejected.output).error.message, 'missing scope');

const compact = captureIo();
const compactStatus = await runFeishuActionCommand([
  'base.records', '--profile', profile, '--base-token', 'app123', '--table-id', 'tbl123', '--field', 'Note',
], compact.io, async () => ({ stdout: JSON.stringify({ ok: true,
  records: [{ record_id: 'rec123', fields: { Note: 'x'.repeat(1000) } }],
}) }));
assert.equal(compactStatus, 0);
assert.equal(JSON.parse(compact.output).truncated, true);
assert.ok(JSON.parse(compact.output).records[0].fields.Note.length < 310);

const safeError = captureIo();
const commandError = Object.assign(new Error('Command failed: --text private-body'), {
  cmd: 'lark-cli --text private-body', code: 1, stdout: '{"ok":false,"error":{"message":"missing scope"}}',
});
assert.equal(await runFeishuActionCommand([
  'message.send', '--profile', profile, '--user-id', userId, '--text', 'private-body', '--key', 'message-run-2',
], safeError.io, async () => { throw commandError; }), 1);
assert.equal(safeError.error.trim(), 'missing scope');

console.log('Feishu reusable Bot actions, fixed card template, argument safety and readback passed');
