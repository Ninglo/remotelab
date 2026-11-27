import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeAdapter, buildClaudeArgs } from '../chat/adapters/claude.mjs';
import { createCodexAdapter } from '../chat/adapters/codex.mjs';
import { parseProgressMessage } from '../lib/assistant-surface-messages.mjs';
import { recoverClaudeRules } from '../chat/claude-rule-recovery.mjs';
import { harnessCapability } from '../chat/harness-capabilities.mjs';

const line = message => JSON.stringify(message);
assert.equal(harnessCapability('claude', 'subagent_attribution'), 'remotelab');
assert.equal(harnessCapability('pi', 'progress'), 'missing');
let adapter = createClaudeAdapter();
assert.deepEqual(adapter.parseLine(line({
  type: 'assistant', parent_tool_use_id: 'agent-tool', message: { content: [{ type: 'text', text: 'child report' }] },
})), [], 'Claude sub-agent assistant text must stay out of the main timeline');
assert.deepEqual(adapter.parseLine(line({
  type: 'user', parent_tool_use_id: 'agent-tool', message: { content: [{ type: 'tool_result', tool_use_id: 'child-tool', content: 'child result' }] },
})), [], 'Claude sub-agent tool results must stay out of the main timeline');
const progress = adapter.parseLine(line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'progress-1', name: 'mcp__remotelab__remotelab_progress', input: { text: '发现阻塞条件，正在修复。' } }] } }));
assert.equal(progress.length, 1);
assert.equal(progress[0].messageKind, 'progress_message');
assert.equal(parseProgressMessage(progress[0].content).progress, '发现阻塞条件，正在修复。');
const progressState = adapter.getProjectionState();
assert.deepEqual(adapter.parseLine(line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'progress-1', content: 'ok' }] } })), []);
const todo = adapter.parseLine(line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'todo-1', name: 'TodoWrite', input: { todos: [{ content: '写测试', status: 'pending' }, { content: '读回执', status: 'completed' }] } }] } }));
assert.equal(todo[0].messageKind, 'todo_list');
assert.equal(todo[0].content, '[ ] 写测试\n[x] 读回执');
const file = adapter.parseLine(line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'edit-1', name: 'Edit', input: { file_path: '/tmp/example.mjs', old_string: 'a', new_string: 'b' } }] } }));
assert.equal(file[0].type, 'file_change');
assert.equal(file[0].filePath, '/tmp/example.mjs');
assert.equal(file[0].changeType, 'edit');
const restored = createClaudeAdapter();
restored.restoreProjectionState(progressState);
assert.deepEqual(restored.parseLine(line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'progress-1', content: 'ok' }] } })), [], 'progress tool result suppression survives projection restore');
const args = buildClaudeArgs('prompt', { developerInstructions: 'Use the quick response rules.', ruleRecoverySessionId: 'session-a' });
assert.ok(args.includes('--append-system-prompt'));
assert.ok(args.includes('--mcp-config'));
assert.ok(args.includes('--settings'));
const codexProgress = createCodexAdapter().parseLine(line({ type: 'item.completed', item: {
  id: 'mcp-1', type: 'mcp_tool_call', server: 'remotelab', tool: 'remotelab_progress', arguments: { text: 'Codex progress' }, status: 'completed', result: { ok: true },
} }));
assert.equal(codexProgress.length, 1);
assert.equal(parseProgressMessage(codexProgress[0].content).progress, 'Codex progress');

const root = await mkdtemp(join(tmpdir(), 'claude-rule-recovery-'));
const sessionId = 'session-recovery';
const sessionDigest = createHash('sha256').update(JSON.stringify(sessionId)).digest('hex').slice(0, 24);
const snapshot = { version: 1, scope: { sessionId }, rules: [{ id: 'surface_messages', title: 'Surface messages', content: 'Use progress.' }] };
const snapshotDigest = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
const snapshotDir = join(root, 'rule-context', sessionDigest);
await mkdir(snapshotDir, { recursive: true });
const snapshotPath = join(snapshotDir, `${snapshotDigest}.json`);
await writeFile(snapshotPath, JSON.stringify(snapshot));
const transcript = join(root, 'transcript.jsonl');
await writeFile(transcript, `${JSON.stringify({ type: 'user', message: { role: 'user', content: `## Current RemoteLab rules\nRecovery snapshot: ${snapshotPath}.` } })}\n`);
const recovered = await recoverClaudeRules({ transcript_path: transcript }, sessionId, root);
assert.match(recovered, /RemoteLab context restored/);
assert.match(recovered, /Use progress/);
await writeFile(transcript, `${JSON.stringify({ type: 'user', message: { role: 'user', content: `## Current RemoteLab rules\nRecovery snapshot: ${join(root, 'other.json')}.` } })}\n`);
assert.equal(await recoverClaudeRules({ transcript_path: transcript }, sessionId, root), null, 'recovery must reject snapshots outside the session root');
console.log('test-claude-alignment: ok');
