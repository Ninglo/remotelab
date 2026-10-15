import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexAccounts } from '../lib/codex-accounts.mjs';
import { installPiCredentialFromDeviceLogin } from './pi-auth.mjs';
import { ensurePiModelBaseline } from './pi-model-baseline.mjs';
import { resolveCommand } from './process-runner.mjs';
import { buildToolProcessEnv } from '../lib/user-shell-env.mjs';
import { appendUsageLedgerRecord, buildDetachedUsageLedgerRecord } from './usage-ledger.mjs';
import { REVIEW_MODEL, REVIEW_PROMPT } from './prompt-review-policy.mjs';

// Reuse the installed provider runtime and account pool. Pi's explicit deny
// switches remove ALL tools/extensions/context discovery; source text travels
// on stdin and is never interpreted as @files, shell arguments or instructions.
export async function reviewPromptBatch(segments, { timeoutMs = 180000, command: suppliedCommand } = {}) {
  const wireIds = new Map(segments.map((segment, index) => [`d${index + 1}`, segment.id]));
  const account = await codexAccounts.acquireForRun({ sessionId: '', model: REVIEW_MODEL });
  const dir = await mkdtemp(join(tmpdir(), 'remotelab-prompt-review-'));
  const started = Date.now(); let usage = null, actualModel = '', responseId = '', succeeded = false;
  try {
    await installPiCredentialFromDeviceLogin({ loginAuthFile: join(account.home, 'auth.json'), piAuthFile: join(dir, 'auth.json') });
    await ensurePiModelBaseline(dir);
    const command = suppliedCommand || await resolveCommand('pi');
    const env = buildToolProcessEnv({ PI_CODING_AGENT_DIR: dir });
    const text = await new Promise((resolve, reject) => {
      const proc = spawn(command, ['--mode','json','--print','--no-session','--no-tools','--no-extensions','--no-skills',
        '--no-prompt-templates','--no-context-files','--no-themes','--no-approve','--offline',
        '--provider','openai-codex','--model',REVIEW_MODEL,'--thinking','low','--system-prompt',REVIEW_PROMPT],
      { cwd: dir, env, stdio: ['pipe','pipe','pipe'] });
      account.lease.setToolProcessId(proc.pid).catch(() => {});
      let answer = '', failure = null, fatal = null, bytes = 0, killTimer;
      const stop = error => { fatal ||= error; proc.kill('SIGTERM'); killTimer ||= setTimeout(() => proc.kill('SIGKILL'), 2000); };
      const timer = setTimeout(() => stop(Error('Review model timed out')), timeoutMs);
      const rl = createInterface({ input: proc.stdout });
      rl.on('line', line => {
        bytes += Buffer.byteLength(line);
        if (bytes > 32 * 1024 * 1024) { stop(Error('Review output exceeded limit')); return; }
        let event; try { event = JSON.parse(line); } catch { return; }
        if (event.type === 'tool_execution_start') stop(Error('Reviewer attempted a tool call'));
        const message = event.type === 'message_end' ? event.message : null;
        if (message?.role !== 'assistant') return;
        if (message.usage) {
          usage ||= { input: 0, cacheRead: 0, output: 0 };
          for (const key of ['input','cacheRead','output']) usage[key] += message.usage[key] || 0;
        }
        actualModel = message.model || actualModel; responseId = message.responseId || responseId;
        if (message.content?.some(c => c.type === 'toolCall')) stop(Error('Reviewer returned a tool call'));
        if (['error','aborted'].includes(message.stopReason)) failure = Error('Review provider returned an error');
        else { failure = null; answer = message.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') || ''; }
      });
      proc.stderr.resume(); // Provider diagnostics can echo inputs: never persist them.
      proc.stdin.on('error', () => stop(Error('Review input transport failed')));
      proc.stdin.end(JSON.stringify({ documents: segments.map((s, index) => ({ id: `d${index + 1}`,
        text: s.text.split('\n').map((line, lineIndex) => `${lineIndex + 1} | ${line}`).join('\n') })) }));
      proc.once('error', error => { failure = Error(`Reviewer unavailable (${error.code || 'spawn'})`); });
      proc.once('close', code => {
        clearTimeout(timer); clearTimeout(killTimer); rl.close();
        if (fatal || failure || code !== 0 || actualModel !== REVIEW_MODEL || !answer) reject(fatal || failure || Error('Review did not complete with the selected model'));
        else resolve(answer);
      });
    });
    const object = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    if (!Array.isArray(object.results)) throw Error('Review response missing results');
    for (const row of object.results) row.id = wireIds.get(row.id) || `unknown:${row.id}`;
    succeeded = true;
    return { text: JSON.stringify(object), usage, model: actualModel, responseId, elapsedMs: Date.now() - started,
      inputFormat: 'numbered-lines-v1' };
  } catch (error) {
    error.reviewUsage = { usage, model: actualModel || REVIEW_MODEL, responseId, elapsedMs: Date.now() - started };
    throw error;
  } finally {
    if (usage) {
      const record = buildDetachedUsageLedgerRecord({ session: { id: '', tool: 'pi', model: `openai-codex/${actualModel || REVIEW_MODEL}` },
        usageEvent: { inputTokens: (usage.input || 0) + (usage.cacheRead || 0), cachedInputTokens: usage.cacheRead || 0, outputTokens: usage.output || 0 },
        tracking: { operation: 'prompt_security_review', tool: 'pi', model: `openai-codex/${actualModel || REVIEW_MODEL}`, state: succeeded ? 'completed' : 'failed' } });
      if (record) appendUsageLedgerRecord(record);
    }
    await rm(dir, { recursive: true, force: true });
    await account?.lease.release();
  }
}
