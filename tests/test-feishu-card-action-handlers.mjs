import assert from 'node:assert/strict';
import { normalizeCardActionHandlers, handleConfiguredCardAction } from '../connectors/feishu/card-action-handlers.mjs';

const raw = { event: { operator: { open_id: 'ou_owner' }, context: { open_chat_id: 'oc_group' }, action: { value: { namespace: 'test_action', input: '$(false)' } } } };
const handlers = normalizeCardActionHandlers({ test_action: { argv: [process.execPath, '-e', "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({toast:{type:'success',content:JSON.parse(s).event.action.value.input}})));"], allowedChatIds: ['oc_group'] } });
let authorized = 0;
const options = { handlers, authorize: async summary => { assert.equal(summary.sender.openId, 'ou_owner'); authorized++; return true; } };
assert.equal((await handleConfiguredCardAction(raw, options)).toast.content, '$(false)');
assert.equal(authorized, 1);
assert.equal((await handleConfiguredCardAction(raw, { ...options, authorize: async () => false })).toast.type, 'error');
assert.equal((await handleConfiguredCardAction({ event: { ...raw.event, context: { open_chat_id: 'oc_wrong' } } }, options)).toast.type, 'error');
assert.equal(await handleConfiguredCardAction({ action: { value: { namespace: 'unknown' } } }, options), null);
assert.equal(await handleConfiguredCardAction({ action: { value: '{bad' } }, options), null);
assert.throws(() => normalizeCardActionHandlers({ unsafe: { argv: 'sh -c false', allowedChatIds: ['oc_group'] } }));
assert.equal((await handleConfiguredCardAction(raw, { ...options, handlers: { test_action: { ...handlers.test_action, argv: [process.execPath, '-e', 'setInterval(()=>{},100)'] } }, timeoutMs: 80 })).toast.type, 'error');
assert.equal((await handleConfiguredCardAction(raw, { ...options, handlers: { test_action: { ...handlers.test_action, argv: [process.execPath, '-e', "process.stdout.write('x'.repeat(70000))"] } } })).toast.type, 'error');
console.log('test-feishu-card-action-handlers: ok');
