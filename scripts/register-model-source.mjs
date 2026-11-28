#!/usr/bin/env node
import { findPerson, loadAuthDocument } from '../lib/auth-config.mjs';
import { getToolDefinitionAsync } from '../lib/tools.mjs';
import { LEGACY_CLAUDE_SOURCE, modelSourceStore } from '../lib/model-source-scope.mjs';

// Operator-only. This registers ownership, never accepts API credentials.
const [id, ownerPersonId, ...extra] = process.argv.slice(2);
try {
  if (!id || !ownerPersonId || extra.length) throw new Error('Usage: node scripts/register-model-source.mjs <tool-id> <verified-owner-person-id>');
  const auth = await loadAuthDocument({ persistMigration: false });
  const person = findPerson(auth, ownerPersonId);
  if (!person?.identities?.length) throw new Error('Owner must be an existing verified Person');
  const tool = await getToolDefinitionAsync(id);
  if (!tool || (id !== LEGACY_CLAUDE_SOURCE && !tool.managedProviderSource)) throw new Error('Configure the managed provider tool first');
  const record = await modelSourceStore.update(id, ownerPersonId, {
    scope: 'personal', memberPersonIds: [], enabled: true, revision: 0,
  }, { create: true });
  console.log(JSON.stringify({ id: record.id, scope: record.scope, revision: record.revision }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
