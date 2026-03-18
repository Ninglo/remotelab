#!/usr/bin/env node
import assert from 'assert/strict';
import {
  buildCodexArgs,
  DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
} from '../chat/adapters/codex.mjs';

const args = buildCodexArgs('Say hello.', {});
assert.equal(args[0], 'exec');
assert.equal(args.at(-1), 'Say hello.');
assert.equal(args.includes('IMPORTANT: Complete ALL requested work in this single response.'), false);
const defaultDeveloperInstructionIndex = args.indexOf('-c');
assert.notEqual(defaultDeveloperInstructionIndex, -1);
assert.equal(
  args[defaultDeveloperInstructionIndex + 1],
  `developer_instructions=${JSON.stringify(DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS)}`,
);

const overridden = buildCodexArgs('Say hello.', { systemPrefix: 'PREFIX\n\n' });
assert.equal(overridden.at(-1), 'PREFIX\n\nSay hello.');

const withDeveloperInstructions = buildCodexArgs('Say hello.', {
  developerInstructions: 'Use plain prose.',
});
const developerInstructionIndex = withDeveloperInstructions.indexOf('-c');
assert.notEqual(developerInstructionIndex, -1);
assert.equal(
  withDeveloperInstructions[developerInstructionIndex + 1],
  'developer_instructions="Use plain prose."',
);

const withoutDeveloperInstructions = buildCodexArgs('Say hello.', {
  developerInstructions: '',
});
assert.equal(withoutDeveloperInstructions.includes('developer_instructions='), false);

console.log('ok - codex args do not inject a default system prefix');
console.log('ok - codex args inject a lightweight default developer instruction');
console.log('ok - codex args still allow explicit per-run system prefixes');
console.log('ok - codex args allow explicit developer instructions via config override');
console.log('ok - codex args allow explicit opt-out of developer instructions');
