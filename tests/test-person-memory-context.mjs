import assert from 'node:assert/strict';
import { buildPersonMemoryPromptBlock } from '../chat/person-memory-context.mjs';

const authDocument = { people: [
  { id: 'person_alpha', identities: [{ id: 'identity_alpha' }] },
  { id: 'person_beta', identities: [{ id: 'identity_beta' }] },
] };
const options = { authDocument, memoryDir: '/isolated-memory' };
const alpha = buildPersonMemoryPromptBlock({ ...options, personId: 'person_alpha', identityId: 'identity_alpha' });
const beta = buildPersonMemoryPromptBlock({ ...options, personId: 'person_beta', identityId: 'identity_beta' });
assert.match(alpha, /reference\/people\/person_alpha\.md/);
assert.doesNotMatch(alpha, /person_beta/);
assert.match(beta, /reference\/people\/person_beta\.md/);
assert.doesNotMatch(beta, /person_alpha/);
assert.match(beta, /file contents are not loaded/);
assert.match(beta, /not in shared AGENTS\.md/);
assert.match(alpha, /work people --query 称呼/);
assert.match(alpha, /memory context --query <topic>/);
assert.match(alpha, /read the needed section separately/);
const priorGuidance = 'For forms of address, writing or collaboration preferences, read this Person record when relevant. '
  + 'Personal preferences belong in that record, not in shared AGENTS.md or another Person profile. '
  + 'A missing file means no profile has been recorded. Shared-account identity does not prove who the human author is.';
assert.ok(alpha.split('\n').at(-1).length <= priorGuidance.length,
  'retrieval guidance replaces the pointer text without growing ordinary-turn context');
assert.ok(Buffer.byteLength(alpha.split('\n').at(-1)) <= Buffer.byteLength(priorGuidance));
for (const [personId, identityId] of [
  ['person_alpha', 'identity_beta'], ['person_alpha', 'unknown'],
  ['person_system', 'identity_system'], ['person_alpha/../person_beta', 'identity_alpha'],
  ['person_alpha', ''], ['', 'identity_alpha'],
]) assert.equal(buildPersonMemoryPromptBlock({ ...options, personId, identityId }), '');
assert.equal(buildPersonMemoryPromptBlock({ ...options, personId: 'person_alpha', identityId: 'identity_alpha', authDocument: null }), '');
console.log('test-person-memory-context: ok; per-request Person isolation, unknown/system identity, traversal rejection, and pointer-only projection');
