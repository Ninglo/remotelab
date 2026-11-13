import { findIdentity, getAuthReadSnapshot, SYSTEM_PERSON_ID } from '../lib/auth-config.mjs';
import { codexAccounts } from '../lib/codex-accounts.mjs';

export async function captureCodexAccountPolicy(options = {}, pool = codexAccounts, document = getAuthReadSnapshot()) {
  const person = options.initiatedByIdentityId ? findIdentity(document, options.initiatedByIdentityId)?.person : null;
  const personId = person && person.id === options.viewPersonId && person.id !== SYSTEM_PERSON_ID ? person.id : '';
  return pool.executionPolicy(personId);
}
