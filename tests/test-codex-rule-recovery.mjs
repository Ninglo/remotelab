import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setIsolatedTestHome } from './isolate-test-environment.mjs';
const home = await mkdtemp(join(tmpdir(), 'rules-recovery-')); setIsolatedTestHome(home);
const { CONFIG_DIR } = await import('../lib/config.mjs');
const { recoverCodexRules } = await import('../chat/codex-rule-recovery.mjs');
const { projectRuleContext } = await import('../chat/rule-context.mjs');
try {
  const a = await projectRuleContext('s', [{ id: 'strict_start_check', title: 'Personal', content: 'A_ONLY' }], { enabled: true, requestId: 'a', personId: 'a' });
  const b = await projectRuleContext('s', [{ id: 'surface_messages', title: 'Display', content: 'B_CURRENT' }], { enabled: true, requestId: 'b', personId: 'b' });
  const transcript = join(home, 'rollout.jsonl');
  const record = (path, role = 'user', type = 'response_item') => JSON.stringify({ type, payload: { type: 'message', role, content: [{ type: 'input_text', text: `<private>\n## Current RemoteLab rules\nRecovery snapshot: ${path}.\n</private>` }] } });
  await writeFile(transcript, [record(a.receipt.file), record(b.receipt.file), record(a.receipt.file, 'assistant'), record(a.receipt.file, 'tool')].join('\n'));
  const got = await recoverCodexRules({ transcript_path: transcript }, 's');
  assert.match(got, /B_CURRENT/); assert.doesNotMatch(got, /A_ONLY/);
  assert.match(got, /user-scoped/); assert.match(got, /Explicit current user instructions/);
  assert.equal(await recoverCodexRules({ transcript_path: transcript }, 'other'), null);
  await writeFile(b.receipt.file, '{}');
  await assert.rejects(recoverCodexRules({ transcript_path: transcript }, 's'), /does not match/);
  console.log('native rule recovery: latest consumed input, personal switch/revocation, ignores tool/assistant text, scoped content hash and failure passed');
} finally { await rm(home, { recursive: true, force: true }); }
