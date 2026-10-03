import { join } from 'node:path';
import { MEMORY_DIR } from '../lib/config.mjs';
import { findIdentity, getCachedAuthDocument, SYSTEM_IDENTITY_ID, SYSTEM_PERSON_ID } from '../lib/auth-config.mjs';

// Route the current request's verified identity. Never fall back to the Session
// creator, sidebar owner, machine user, display name, or another Person's file.
export function buildPersonMemoryPromptBlock({
  personId = '', identityId = '', authDocument = getCachedAuthDocument(), memoryDir = MEMORY_DIR,
} = {}) {
  if (!/^person_[a-zA-Z0-9_-]{1,100}$/.test(personId)
      || !identityId || identityId === SYSTEM_IDENTITY_ID || personId === SYSTEM_PERSON_ID) return '';
  const matched = findIdentity(authDocument, identityId);
  if (matched?.person?.id !== personId) return '';
  return [
    'Person memory pointer (current request identity; file contents are not loaded or certified):',
    JSON.stringify({ personId, index: join(memoryDir, 'reference', 'people', 'index.md'),
      profile: join(memoryDir, 'reference', 'people', `${personId}.md`) }),
    'For forms of address, writing or collaboration preferences, read this Person record when relevant. '
      + 'Personal preferences belong in that record, not in shared AGENTS.md or another Person profile. '
      + 'A missing file means no profile has been recorded. Shared-account identity does not prove who the human author is.',
  ].join('\n');
}
