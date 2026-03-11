#!/usr/bin/env node
/**
 * Targeted tests for specific scenarios that might cause Codex to "stop mid-execution":
 *
 * Test A: Resume behavior — does resuming a thread work correctly?
 * Test B: Cancel + re-send — what happens when the session-manager cancels an in-progress runner?
 * Test C: Long-running task — does a task that takes many steps complete?
 * Test D: Error recovery — does Codex stop on internal errors?
 */
import { spawn, execFileSync } from 'child_process';
import { createInterface } from 'readline';
import { existsSync } from 'fs';

function resolveCommand(cmd) {
  const home = process.env.HOME || '';
  const preferred = [
    `${home}/.local/bin/${cmd}`,
    `${home}/Library/pnpm/${cmd}`,
    `/opt/homebrew/bin/${cmd}`,
    `/usr/local/bin/${cmd}`,
  ];
  for (const p of preferred) {
    if (p && existsSync(p)) return p;
  }
  try {
    return execFileSync('which', [cmd], { encoding: 'utf8', timeout: 3000 }).trim();
  } catch {
    return cmd;
  }
}

const codexPath = resolveCommand('codex');

function runCodex(args, label, { killAfterMs, maxDurationMs = 120000 } = {}) {
  return new Promise((resolve) => {
    console.log(`\n--- ${label} ---`);
    console.log(`  Args: ${JSON.stringify(args).slice(0, 200)}`);

    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

    const startTime = Date.now();
    const proc = spawn(codexPath, args, {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cleanEnv,
    });
    proc.stdin.end();

    const rl = createInterface({ input: proc.stdout });
    const events = [];
    let threadId = null;
    let stderrBuf = '';
    let killed = false;

    // Auto-kill after specified time (simulating what session-manager does)
    let killTimer = null;
    if (killAfterMs) {
      killTimer = setTimeout(() => {
        console.log(`  [${Date.now() - startTime}ms] ** SENDING SIGTERM (simulating cancel) **`);
        killed = true;
        proc.kill('SIGTERM');
      }, killAfterMs);
    }

    // Safety timeout
    const safetyTimer = setTimeout(() => {
      console.log(`  [${Date.now() - startTime}ms] ** SAFETY TIMEOUT - killing process **`);
      killed = true;
      proc.kill('SIGTERM');
    }, maxDurationMs);

    rl.on('line', (line) => {
      const elapsed = Date.now() - startTime;
      let obj;
      try { obj = JSON.parse(line.trim()); } catch { return; }

      if (obj.type === 'thread.started' && obj.thread_id) threadId = obj.thread_id;
      events.push(obj);

      if (obj.type === 'item.completed' && obj.item) {
        const i = obj.item;
        if (i.type === 'agent_message') console.log(`  [${elapsed}ms] MSG: "${i.text?.slice(0, 100)}"`);
        else if (i.type === 'command_execution') console.log(`  [${elapsed}ms] CMD: ${i.command?.slice(0, 60)} → exit ${i.exit_code}`);
        else if (i.type === 'reasoning') console.log(`  [${elapsed}ms] THINK: "${i.text?.slice(0, 60)}"`);
      } else if (obj.type === 'turn.completed') {
        console.log(`  [${elapsed}ms] TURN COMPLETED`);
      } else if (obj.type === 'turn.failed') {
        console.log(`  [${elapsed}ms] TURN FAILED: ${obj.error?.message}`);
      }
    });

    proc.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });

    proc.on('exit', (code, signal) => {
      clearTimeout(safetyTimer);
      if (killTimer) clearTimeout(killTimer);
      const duration = Date.now() - startTime;
      const hasTurnCompleted = events.some(e => e.type === 'turn.completed');
      const hasTurnFailed = events.some(e => e.type === 'turn.failed');
      const cmdCount = events.filter(e => e.type === 'item.completed' && e.item?.type === 'command_execution').length;

      console.log(`  Exit: code=${code}, signal=${signal}, duration=${duration}ms, killed=${killed}`);
      console.log(`  Commands: ${cmdCount}, TurnCompleted: ${hasTurnCompleted}, TurnFailed: ${hasTurnFailed}`);
      if (stderrBuf.trim()) console.log(`  STDERR: ${stderrBuf.trim().slice(0, 300)}`);

      resolve({ events, threadId, code, signal, duration, hasTurnCompleted, hasTurnFailed, cmdCount, killed });
    });
  });
}

async function testA_Resume() {
  console.log('\n=== TEST A: Resume behavior ===');
  console.log('Does "codex exec resume <thread_id> <prompt>" work correctly?\n');

  // First turn
  const r1 = await runCodex(
    ['exec', '--json', '--full-auto', 'Run "ls package.json" and tell me if it exists. Do not modify files.'],
    'Turn 1 (initial)'
  );

  if (!r1.threadId) {
    console.log('  FAIL: No thread_id captured, cannot test resume');
    return;
  }

  console.log(`\n  Thread ID: ${r1.threadId}`);

  // Resume with new prompt
  const r2 = await runCodex(
    ['exec', '--json', '--full-auto', 'resume', r1.threadId, 'Now run "cat package.json | head -5" and show me the first 5 lines. Do not modify files.'],
    'Turn 2 (resume)'
  );

  console.log(`\n  TEST A Result:`);
  console.log(`  Turn 1: completed=${r1.hasTurnCompleted}, cmds=${r1.cmdCount}`);
  console.log(`  Turn 2: completed=${r2.hasTurnCompleted}, cmds=${r2.cmdCount}`);
  if (r2.hasTurnCompleted) {
    console.log('  PASS: Resume works correctly');
  } else {
    console.log('  FAIL: Resume did not complete!');
    if (r2.stderrBuf) console.log(`  STDERR: ${r2.stderrBuf}`);
  }
}

async function testB_CancelAndResend() {
  console.log('\n=== TEST B: Cancel (SIGTERM) + re-send ===');
  console.log('Simulates what session-manager does when user sends a new message while Codex is running.\n');

  // Start a task but kill it after 5 seconds
  const r1 = await runCodex(
    ['exec', '--json', '--full-auto', 'Run these commands one by one: "ls -la", "cat package.json", "ls lib/", "wc -l lib/*.mjs". Do not modify files.'],
    'Turn 1 (will be killed after 5s)',
    { killAfterMs: 5000 }
  );

  console.log(`\n  Turn 1 was killed=${r1.killed}, threadId=${r1.threadId}`);

  if (r1.threadId) {
    // Try to resume after kill
    const r2 = await runCodex(
      ['exec', '--json', '--full-auto', 'resume', r1.threadId, 'Please continue where you left off.'],
      'Turn 2 (resume after kill)'
    );

    console.log(`\n  TEST B Result:`);
    console.log(`  Turn 1 (killed): cmds=${r1.cmdCount}`);
    console.log(`  Turn 2 (resumed): completed=${r2.hasTurnCompleted}, cmds=${r2.cmdCount}`);
    if (r2.hasTurnCompleted) {
      console.log('  Resume after kill works');
    } else {
      console.log('  Resume after kill FAILED');
    }
  }
}

async function testC_LongTask() {
  console.log('\n=== TEST C: Longer multi-step task ===');
  console.log('Tests a task that requires many sequential steps.\n');

  const prompt = `Please do ALL of these steps in order, executing each command and reporting the result:
1. Run "ls -la" to show the root directory
2. Run "cat package.json" to read package info
3. Run "ls lib/" to list library files
4. Run "head -20 lib/config.mjs" to read config
5. Run "head -20 lib/tools.mjs" to read tools
6. Run "head -20 chat/session-manager.mjs" to read session orchestration
7. Run "git log --oneline -5" to show recent commits
8. After all steps, give me a comprehensive summary.
Do NOT modify any files. Do NOT skip any command.`;

  const r = await runCodex(
    ['exec', '--json', '--full-auto', prompt],
    'Long task (8 commands)',
    { maxDurationMs: 180000 }
  );

  console.log(`\n  TEST C Result:`);
  console.log(`  completed=${r.hasTurnCompleted}, commands=${r.cmdCount}/7+`);
  if (r.cmdCount < 7) {
    console.log(`  *** INCOMPLETE: Only ${r.cmdCount}/7+ commands executed ***`);
    console.log('  This confirms the "stop mid-execution" issue for longer tasks!');
  }
}

async function main() {
  console.log('=== Codex Issue Diagnostic Tests ===');
  console.log(`Codex: ${codexPath} (v${execFileSync(codexPath, ['--version'], { encoding: 'utf8' }).trim()})`);
  console.log(`CWD: ${process.cwd()}`);

  await testA_Resume();
  await testB_CancelAndResend();
  await testC_LongTask();

  console.log('\n=== ALL TESTS COMPLETE ===');
}

main().catch(console.error);
