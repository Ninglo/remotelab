import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const PERSONAL_CODEX_FALLBACK = 'shared_on_exhaustion';
export const isPersonalCodexAccount = account => account?.scope === 'personal';
export const isSharedCodexAccount = account => Boolean(account
  && (!account.scope || account.scope === 'shared') && !account.ownerPersonId);
export const validCodexAccountOwnership = account => isSharedCodexAccount(account)
  || (isPersonalCodexAccount(account) && typeof account.ownerPersonId === 'string'
    && /^person_[a-zA-Z0-9_-]+$/.test(account.ownerPersonId) && account.id !== 'default');

// The subject identifies the login across workspaces. Never use email or a
// user-provided label to establish exclusive ownership.
export async function readCodexSubscriptionIdentity(home) {
  let auth;
  try { auth = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  if (!auth.tokens?.id_token) return {};
  const claims = JSON.parse(Buffer.from(auth.tokens.id_token.split('.')[1] || '', 'base64url'));
  const workspace = auth.tokens.account_id || claims['https://api.openai.com/auth']?.chatgpt_account_id;
  if (!claims.sub || !workspace) return {};
  const digest = text => createHash('sha256').update(text).digest('hex');
  return { identityId: digest(`${claims.sub}:${workspace}`), subjectId: digest(claims.sub) };
}

export function codexOwnershipConflict(account, identity, other, otherIdentity = other) {
  if (account.id === other.id || !(isPersonalCodexAccount(account) || isPersonalCodexAccount(other))) return false;
  return Boolean((identity.subjectId && identity.subjectId === otherIdentity.subjectId)
    || (identity.identityId && identity.identityId === otherIdentity.identityId));
}

export function sameCodexExecutionOwner(a, b) {
  if (!a?.personalAccountId && !b?.personalAccountId) return true;
  return Boolean(a?.personId && a.personId === b?.personId
    && a.personalAccountId === b.personalAccountId);
}

export function personalCodexFallbackText() {
  return '你的个人 Codex 账号额度已耗尽，本次任务已改用公共账号池继续执行。个人额度恢复后的新请求会优先使用个人账号。';
}
