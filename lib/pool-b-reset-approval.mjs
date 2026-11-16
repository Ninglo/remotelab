import { randomUUID } from 'crypto';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { spawn } from 'child_process';

export const POOL_B_RESET_COMMAND = '/usr/local/bin/robodojo-pool-b';
export const DEFAULT_POOL_B_RESET_STATE_DIR = join(
  homedir(),
  '.config',
  'remotelab',
  'feishu-connector',
  'pool-b-reset-approvals',
);
const REQUEST_ID_PATTERN = /^rb-reset-[a-f0-9]{12}$/;
const ACCOUNT_PATTERN = /^[A-Za-z0-9._-]+$/;
const MAX_OUTPUT_LENGTH = 4000;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePath(value, fallback = DEFAULT_POOL_B_RESET_STATE_DIR) {
  const candidate = trimString(value) || fallback;
  if (candidate === '~') return homedir();
  if (candidate.startsWith('~/')) return join(homedir(), candidate.slice(2));
  return resolve(candidate);
}

export function resolvePoolBResetStateDir(value) {
  return normalizePath(value);
}

function normalizeIdentity(value = {}) {
  return {
    openId: trimString(value.openId || value.open_id),
    userId: trimString(value.userId || value.user_id),
    unionId: trimString(value.unionId || value.union_id),
    name: trimString(value.name || value.displayName),
  };
}

function identityValues(value) {
  const identity = normalizeIdentity(value);
  return [identity.openId, identity.userId, identity.unionId].filter(Boolean);
}

function identitiesMatch(left, right) {
  const rightValues = new Set(identityValues(right));
  return identityValues(left).some((value) => rightValues.has(value));
}

function requestPath(stateDir, requestId) {
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new Error(`Invalid request id: ${requestId}`);
  return join(resolvePoolBResetStateDir(stateDir), `${requestId}.json`);
}

async function writeJsonAtomic(pathname, value) {
  await mkdir(dirname(pathname), { recursive: true });
  const temporaryPath = `${pathname}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, pathname);
}

async function readRequest(stateDir, requestId) {
  const pathname = requestPath(stateDir, requestId);
  let raw;
  try {
    raw = await readFile(pathname, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`Reset approval not found: ${requestId}`);
    throw error;
  }
  let request;
  try {
    request = JSON.parse(raw);
  } catch {
    throw new Error(`Reset approval record is invalid: ${requestId}`);
  }
  return { pathname, request };
}

function requireAccount(account) {
  const normalized = trimString(account);
  if (!ACCOUNT_PATTERN.test(normalized)) {
    throw new Error('Pool B account must be an exact configured slot such as codex_a_4');
  }
  return normalized;
}

function createRequestId() {
  return `rb-reset-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

export async function createPoolBResetRequest({
  stateDir,
  account,
  accountLabel = '',
  creditId = '',
  chatId,
  threadId = '',
  requester,
  reason = '',
  cardsAvailable = null,
  expiresInMs = 30 * 60 * 1000,
  now = new Date(),
}) {
  const normalizedAccount = requireAccount(account);
  const normalizedChatId = trimString(chatId);
  if (!normalizedChatId) throw new Error('chatId is required for a group approval');
  const requesterIdentity = normalizeIdentity(requester);
  if (!identityValues(requesterIdentity).length) {
    throw new Error('requester identity is required for a group approval');
  }
  const createdAt = now.toISOString();
  const request = {
    version: 1,
    requestId: createRequestId(),
    status: 'pending',
    account: normalizedAccount,
    accountLabel: trimString(accountLabel),
    creditId: trimString(creditId),
    chatId: normalizedChatId,
    threadId: trimString(threadId),
    requester: requesterIdentity,
    reason: trimString(reason),
    cardsAvailable: Number.isInteger(cardsAvailable) ? cardsAvailable : null,
    idempotencyKey: randomUUID(),
    createdAt,
    expiresAt: new Date(now.getTime() + expiresInMs).toISOString(),
    approvedAt: '',
    approvedBy: null,
    executedAt: '',
    receipt: null,
  };
  await writeJsonAtomic(requestPath(stateDir, request.requestId), request);
  return request;
}

export async function loadPoolBResetRequest(stateDir, requestId) {
  return (await readRequest(stateDir, requestId)).request;
}

export function parsePoolBResetApprovalCommand(text) {
  const normalized = trimString(text)
    .replace(/@_[A-Za-z0-9_]+/g, ' ')
    .replace(/[。！？!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const match = normalized.match(/^(批准|approve)\s+(?:reset\s+)?(rb-reset-[a-f0-9]{12})$/i);
  if (match) return { type: 'approve_pool_b_reset', requestId: match[2] };
  const rejectMatch = normalized.match(/^(拒绝|reject)\s+(?:reset\s+)?(rb-reset-[a-f0-9]{12})$/i);
  if (rejectMatch) return { type: 'reject_pool_b_reset', requestId: rejectMatch[2] };
  return null;
}

export function formatPoolBResetApprovalMessage(request) {
  const account = request.accountLabel
    ? `${request.accountLabel}（${request.account}）`
    : request.account;
  const cards = Number.isInteger(request.cardsAvailable) ? `${request.cardsAvailable} 张` : '待复核';
  const reason = request.reason || '未填写';
  return [
    '【Pool B Reset 使用审批】',
    `账号：${account}`,
    `当前可用重置卡：${cards}`,
    `用途：${reason}`,
    `请求号：${request.requestId}`,
    '',
    `确认使用一张请回复：批准 Reset ${request.requestId}`,
    `拒绝请回复：拒绝 Reset ${request.requestId}`,
    '批准后才会调用 reset-credit；未收到明确批准不会消费。',
  ].join('\n');
}

function assertRequestScope(request, { chatId, threadId }) {
  if (trimString(chatId) !== request.chatId) throw new Error('Approval must come from the requesting group');
  if (request.threadId && trimString(threadId) && request.threadId !== trimString(threadId)) {
    throw new Error('Approval must come from the requesting topic');
  }
}

function assertNotExpired(request, now) {
  if (request.expiresAt && new Date(request.expiresAt).getTime() <= now.getTime()) {
    throw new Error(`Reset approval expired: ${request.requestId}`);
  }
}

export async function approvePoolBResetRequest({
  stateDir,
  requestId,
  approver,
  chatId,
  threadId = '',
  now = new Date(),
}) {
  const { pathname, request } = await readRequest(stateDir, requestId);
  if (request.status === 'consumed' || request.status === 'executing') return request;
  if (request.status !== 'pending') throw new Error(`Reset approval is ${request.status}`);
  assertRequestScope(request, { chatId, threadId });
  assertNotExpired(request, now);
  if (!identitiesMatch(request.requester, approver)) {
    throw new Error('Only the requester (or a separately configured approver) may approve this reset');
  }
  request.status = 'approved';
  request.approvedAt = now.toISOString();
  request.approvedBy = normalizeIdentity(approver);
  await writeJsonAtomic(pathname, request);
  return request;
}

export async function rejectPoolBResetRequest({
  stateDir,
  requestId,
  rejecter,
  chatId,
  threadId = '',
  now = new Date(),
}) {
  const { pathname, request } = await readRequest(stateDir, requestId);
  if (request.status === 'consumed' || request.status === 'executing') return request;
  if (request.status !== 'pending') throw new Error(`Reset approval is ${request.status}`);
  assertRequestScope(request, { chatId, threadId });
  assertNotExpired(request, now);
  if (!identitiesMatch(request.requester, rejecter)) {
    throw new Error('Only the requester (or a separately configured approver) may reject this reset');
  }
  request.status = 'rejected';
  request.rejectedAt = now.toISOString();
  request.rejectedBy = normalizeIdentity(rejecter);
  await writeJsonAtomic(pathname, request);
  return request;
}

function runPoolBReset(args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn('sudo', ['-n', POOL_B_RESET_COMMAND, 'reset-credit', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code, signal) => resolveResult({ code, signal, stdout, stderr }));
  });
}

export async function consumeApprovedPoolBReset({
  stateDir,
  requestId,
  chatId,
  threadId = '',
  runner = runPoolBReset,
  now = new Date(),
}) {
  const { pathname, request } = await readRequest(stateDir, requestId);
  if (request.status === 'consumed' || request.status === 'failed') return request;
  if (request.status !== 'approved') throw new Error(`Reset approval is ${request.status}; explicit approval is required`);
  assertRequestScope(request, { chatId, threadId });
  request.status = 'executing';
  await writeJsonAtomic(pathname, request);

  const args = [
    '--account', request.account,
    '--idempotency-key', request.idempotencyKey,
    ...(request.creditId ? ['--credit-id', request.creditId] : []),
    '--confirm',
  ];
  let result;
  try {
    result = await runner(args);
  } catch (error) {
    request.status = 'failed';
    request.executedAt = now.toISOString();
    request.receipt = { code: null, error: error?.message || String(error) };
    await writeJsonAtomic(pathname, request);
    throw error;
  }

  request.status = result?.code === 0 ? 'consumed' : 'failed';
  request.executedAt = now.toISOString();
  request.receipt = {
    code: result?.code ?? null,
    signal: result?.signal || '',
    stdout: trimString(result?.stdout).slice(0, MAX_OUTPUT_LENGTH),
    stderr: trimString(result?.stderr).slice(0, MAX_OUTPUT_LENGTH),
  };
  await writeJsonAtomic(pathname, request);
  return request;
}

export async function approveAndConsumePoolBReset(options) {
  const approved = await approvePoolBResetRequest(options);
  if (approved.status === 'consumed' || approved.status === 'failed') return approved;
  return consumeApprovedPoolBReset(options);
}

export function formatPoolBResetResult(request) {
  if (request.status === 'consumed') {
    return `Reset 已执行：${request.accountLabel || request.account}，请求号 ${request.requestId}，命令返回码 ${request.receipt?.code ?? 0}。`;
  }
  if (request.status === 'failed') {
    const detail = trimString(request.receipt?.stderr || request.receipt?.error || request.receipt?.stdout)
      .split('\n')[0]
      .slice(0, 240);
    return `Reset 执行失败：${request.accountLabel || request.account}，请求号 ${request.requestId}。${detail}`.trim();
  }
  return `Reset 审批状态：${request.status}，请求号 ${request.requestId}。`;
}
