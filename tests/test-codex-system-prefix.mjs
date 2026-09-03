#!/usr/bin/env node
import assert from 'assert/strict';

const previousDeveloperInstructions = process.env.REMOTELAB_CODEX_DEVELOPER_INSTRUCTIONS;
delete process.env.REMOTELAB_CODEX_DEVELOPER_INSTRUCTIONS;

const { buildCodexArgs } = await import(`../chat/adapters/codex.mjs?t=${Date.now()}`);

try {
  const args = buildCodexArgs('Say hello.', {});
  assert.equal(args[0], 'exec');
  assert.equal(args.at(-1), 'Say hello.');
  assert.equal(args.some((arg) => arg.startsWith('developer_instructions=')), false);

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
  assert.equal(withoutDeveloperInstructions.some((arg) => arg.startsWith('developer_instructions=')), false);

  console.log('ok - Codex keeps its native developer instructions by default');
  console.log('ok - explicit system-prefix and developer-instruction overrides still work');
} finally {
  if (previousDeveloperInstructions === undefined) {
    delete process.env.REMOTELAB_CODEX_DEVELOPER_INSTRUCTIONS;
  } else {
    process.env.REMOTELAB_CODEX_DEVELOPER_INSTRUCTIONS = previousDeveloperInstructions;
  }
}
