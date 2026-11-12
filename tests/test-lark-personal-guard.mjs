import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';

const home = await mkdtemp(join(tmpdir(), 'lark-personal-guard-'));
setIsolatedTestHome(home);
const { evaluatePersonalLarkCommand: evaluate, guardPersonalLarkCli: guard, PERSONAL_GUARD_FILE } = await import('../lib/lark-personal-guard.mjs');
const policy = { version: 1, enabled: true, mode: 'manual', personId: 'person-owner', profile: 'personal', appId: 'cli_app',
  owner: { route: 'bot', tenant: 'tenant', openId: 'ou_owner' }, conversations: [{ peerOpenId: 'ou_peer', chatId: 'oc_pair' }],
  disclosure: '本条由 index 经本人授权整理并代发。', sourceRequestId: 'permission-source' };
const context = { sessionId: 'session', requestId: 'request', runId: 'run' };
const request = { ...context, options: { viewPersonId: policy.personId, feishuConnectorAuthenticated: true,
  sourceContext: { connector: 'feishu', sourceRouteId: 'bot', tenantKey: 'tenant', sender: { openId: 'ou_owner', senderType: 'user' } } } };
const config = { apps: [{ name: 'personal', appId: 'cli_app', users: [{ userOpenId: 'ou_owner' }] }] };
const args = ['--profile', 'personal', 'im', '+messages-send', '--as', 'user', '--user-id', 'ou_peer', '--text', '进展', '--idempotency-key', 'one', '--dry-run'];
const input = { policy, args, request, latestRequest: request, context, config };
const rejected = (patch, code) => assert.throws(() => evaluate({ ...input, ...patch }), e => e.code === code);
try {
  const first = evaluate(input);
  assert.equal(first.action, 'send-text');
  assert.equal(first.args[first.args.indexOf('--text') + 1], `进展\n\n${policy.disclosure}`);
  assert.deepEqual(evaluate({ ...input, args: first.args }).args, first.args, 'disclosure is appended once');
  const raw = ['--profile=personal', 'api', 'GET', '/open-apis/im/v1/messages', '--as=user', '--params', JSON.stringify({ container_id_type: 'chat', container_id: 'oc_pair', page_size: 1 })];
  assert.equal(evaluate({ ...input, args: raw }).action, 'read-conversation');
  const sentToChat = args.map(x => x === '--user-id' ? '--chat-id' : x === 'ou_peer' ? 'oc_pair' : x);
  assert.equal(evaluate({ ...input, args: sentToChat }).target, 'oc_pair');

  rejected({ context: {} }, 'active_request_required');
  rejected({ request: { ...request, result: { state: 'completed' } } }, 'owner_request_required');
  rejected({ request: { ...request, sessionId: 'other' } }, 'owner_request_required');
  rejected({ request: { ...request, runId: 'other' } }, 'owner_request_required');
  for (const opts of [{ viewPersonId: 'other' }, { feishuConnectorAuthenticated: false }, { scheduleId: 'scheduled' }, { triggerId: 'timed' }, { internalOperation: 'maintenance' }]) {
    rejected({ request: { ...request, options: { ...request.options, ...opts } } }, 'owner_request_required');
  }
  for (const source of [{ sourceRouteId: 'other' }, { tenantKey: 'other' }, { sender: { senderType: 'user', openId: 'ou_intruder' } }]) {
    rejected({ request: { ...request, options: { ...request.options, sourceContext: { ...request.options.sourceContext, ...source } } } }, 'owner_request_required');
  }
  rejected({ latestRequest: null }, 'latest_request_unavailable');
  const intruder = { ...request, requestId: 'steer', options: { ...request.options, viewPersonId: 'intruder' } };
  rejected({ latestRequest: intruder }, 'owner_request_required');
  const ownerFollowup = { ...request, requestId: 'followup', runId: 'child', nativeDispatchRunId: 'run' };
  assert.equal(evaluate({ ...input, latestRequest: ownerFollowup }).action, 'send-text');
  rejected({ config: { apps: [{ ...config.apps[0], users: [{ userOpenId: 'other' }] }] } }, 'account_mismatch');
  rejected({ config: { apps: [{ ...config.apps[0], appId: 'different' }] } }, 'account_mismatch');

  rejected({ args: args.map(x => x === 'ou_peer' ? 'ou_other' : x) }, 'conversation_not_allowed');
  rejected({ args: [...args, '--chat-id', 'oc_pair'] }, 'conversation_not_allowed');
  rejected({ args: [...args, '--profile=other'] }, 'duplicate_option');
  rejected({ args: [...args, '--text=hidden'] }, 'duplicate_option');
  rejected({ args: [...args, '--content', '{"text":"alternate"}'] }, 'unsupported_option');
  rejected({ args: args.map(x => x === '--text' ? '--file' : x) }, 'unsupported_option');
  rejected({ args: args.map(x => x === 'user' ? 'auto' : x) }, 'explicit_user_identity_required');
  rejected({ args: ['--profile', 'personal', 'api', 'POST', '/open-apis/im/v1/messages', '--as', 'user'] }, 'operation_not_allowed');
  rejected({ args: ['--profile', 'personal', 'api', 'GET', '/open-apis/im/v1/messages/om_arbitrary', '--as', 'user'] }, 'operation_not_allowed');
  rejected({ args: [...raw, '--page-all'] }, 'invalid_option');
  rejected({ args: raw.map(x => x.startsWith('{') ? '@query.json' : x) }, 'inline_query_required');
  rejected({ args: raw.map(x => x.startsWith('{') ? JSON.stringify({ container_id_type: 'chat', container_id: 'oc_other' }) : x) }, 'conversation_not_allowed');
  rejected({ args: raw.map(x => x.startsWith('{') ? JSON.stringify({ container_id_type: 'chat', container_id: 'oc_pair', page_size: 500 }) : x) }, 'invalid_page_size');

  rejected({ policy: { ...policy, enabled: false } }, 'disabled');
  rejected({ policy: { ...policy, mode: 'automatic' } }, 'invalid_policy');
  rejected({ policy: { ...policy, expiresAt: 'not-a-date' } }, 'invalid_window');
  const timed = { ...policy, notBefore: '2026-01-01T09:00:00Z', expiresAt: '2026-01-01T10:00:00Z' };
  rejected({ policy: timed, now: Date.parse('2026-01-01T08:59:59Z') }, 'outside_window');
  assert.equal(evaluate({ ...input, policy: timed, now: Date.parse(timed.notBefore) }).action, 'send-text');
  rejected({ policy: timed, now: Date.parse(timed.expiresAt) }, 'outside_window');
  assert.equal(evaluate({ ...input, policy: timed, now: Date.parse(timed.expiresAt), args: ['--profile', 'personal', 'auth', 'logout'] }).action, 'auth-logout', 'expiry never prevents logout');

  const personal = join(home, 'config', 'lark-cli-personal', 'owner'), shared = join(home, 'config', 'lark-cli');
  await mkdir(personal, { recursive: true }); await mkdir(shared, { recursive: true });
  const env = { REMOTELAB_SESSION_ID: 'session', REMOTELAB_REQUEST_ID: 'request', REMOTELAB_RUN_ID: 'run' };
  const runtime = { instanceRoot: home, configDir: personal, env, loadRequest: async () => request, loadLatestRequest: async () => request };
  assert.equal((await guard(['--help'], { ...runtime, configDir: shared })).guarded, false, 'ordinary profiles unchanged');
  await assert.rejects(guard(args, runtime), e => e.code === 'policy_unavailable');
  await writeFile(join(personal, PERSONAL_GUARD_FILE), '{broken');
  await assert.rejects(guard(args, runtime), e => e.code === 'policy_unavailable');
  await writeFile(join(personal, PERSONAL_GUARD_FILE), JSON.stringify(policy));
  await writeFile(join(personal, 'config.json'), JSON.stringify(config));
  assert.equal((await guard(args, runtime)).guarded, true);
  const alias = join(home, 'personal-alias'); await symlink(personal, alias);
  assert.equal((await guard(args, { ...runtime, configDir: alias })).guarded, true, 'symlink cannot evade the policy');
  await assert.rejects(guard(args, { ...runtime, env: {} }), e => e.code === 'active_request_required');
  await assert.rejects(guard(args, { ...runtime, loadRequest: async () => { throw new Error('state unavailable'); } }), /state unavailable/);
  console.log('PASS personal Feishu launcher guard: owner, steering, target, operation, expiry, disclosure, fail-closed policy and shared-profile isolation');
} finally { await rm(home, { recursive: true, force: true }); }
