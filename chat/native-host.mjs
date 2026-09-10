import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createNativeInputServer } from './native-input-transport.mjs';
import { createCodexDriver } from './native/codex.mjs';
import { createPiDriver } from './native/pi.mjs';
import { createClaudeDriver } from './native/claude.mjs';

const factories = { 'codex-json': createCodexDriver, 'pi-json': createPiDriver, 'claude-stream-json': createClaudeDriver };

// The detached sidecar owns the bidirectional native process. The controller
// can disappear without closing stdin or losing the Harness's active tools.
export async function runNativeHost({ directory, command, runtimeFamily, options, prompt, cwd, env, onStdout, onStderr, onProcess, onControl, isCancelled = async () => false }) {
  const createDriver = factories[runtimeFamily];
  if (!createDriver) throw new Error(`Unsupported native Harness ${runtimeFamily}`);
  let proc;
  let server;
  let started = false;
  let closing = false;
  let interruptRequested = false;
  let nativeResult = null;
  let settlementRevision = 0;
  let fatalError = null;
  let submissions = 0;
  let closeTimer;
  let killTimer;
  let writes = Promise.resolve();
  let writeError = null;
  const queueWrite = fn => { writes = writes.then(fn).catch(error => { writeError ||= error; }); };
  const stop = () => {
    if (closing) return;
    closing = true;
    proc?.stdin.end();
    closeTimer = setTimeout(() => proc?.kill('SIGTERM'), 1000);
    killTimer = setTimeout(() => proc?.kill('SIGKILL'), 5000);
  };
  const maybeStop = () => {
    if (started && nativeResult && submissions === 0 && !server?.pending) stop();
  };
  const driver = createDriver({ options, cwd,
    send: message => {
      if (!proc || proc.stdin.destroyed || closing) throw Object.assign(new Error('Native Harness input channel is closed'), { code: 'NATIVE_UNCERTAIN' });
      proc.stdin.write(`${JSON.stringify(message)}\n`);
    },
    onEvent: event => queueWrite(() => onStdout(JSON.stringify(event))),
    onSettled: result => { settlementRevision++; nativeResult = result || { status: 'completed' }; queueMicrotask(maybeStop); },
    onError: error => { fatalError ||= error instanceof Error ? error : new Error(String(error?.message || error)); stop(); },
  });
  proc = spawn(command, driver.args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => {
    proc.once('error', error => { fatalError ||= error; });
    proc.once('close', (code, signal) => resolve({ code, signal }));
  });
  proc.stdin.on('error', error => { if (!closing) { fatalError ||= error; stop(); } });
  const stdout = createInterface({ input: proc.stdout });
  const stderr = createInterface({ input: proc.stderr });
  const readersClosed = Promise.all([stdout, stderr].map(reader => new Promise(resolve => reader.once('close', resolve))));
  stdout.on('line', line => {
    try { driver.handle(JSON.parse(line)); }
    catch (error) { fatalError ||= error; stop(); }
  });
  const stderrLines = [];
  stderr.on('line', line => { stderrLines.push(line); queueWrite(() => onStderr(line)); });
  try {
    await onProcess(proc);
    onControl?.({ interrupt: () => { interruptRequested = true; return driver.interrupt(); } });
    // The endpoint becomes visible before starting the first model call. It
    // accepts follow-ups as soon as the protocol initialization has completed.
    server = await createNativeInputServer({ directory,
      isAccepting: async () => { const cancelled = await isCancelled(); return started && !closing && !interruptRequested && !cancelled; },
      onIdle: () => queueMicrotask(maybeStop),
      submit: async input => {
        submissions++;
        const before = settlementRevision;
        try {
          const receipt = await driver.submit(input);
          // A definite rejection must not erase an already settled turn. A
          // successful input needs another completion unless its driver emitted
          // that completion before resolving the reception promise.
          if (settlementRevision === before) nativeResult = null;
          return receipt;
        }
        finally { submissions--; queueMicrotask(maybeStop); }
      },
    });
    const initial = driver.start(prompt);
    // Drivers perform their own handshake gating. Their start promise is a
    // reception receipt and must not block accepting further stdin messages.
    started = true;
    initial.catch(error => { fatalError ||= error; stop(); });
    const exit = await closed;
    driver.close(fatalError || new Error('Native Harness process exited'));
    await readersClosed;
    await writes;
    const failed = fatalError || writeError || (nativeResult?.status === 'failed' ? new Error(nativeResult.error?.message || nativeResult.error || 'Native Harness turn failed') : null);
    return { code: failed ? 1 : nativeResult ? 0 : (exit.code ?? 1), signal: nativeResult ? null : exit.signal,
      error: failed || (!nativeResult ? new Error('Native Harness exited before reporting completion') : null), stderrText: stderrLines.join('\n') };
  } finally {
    clearTimeout(closeTimer); clearTimeout(killTimer);
    driver.close(fatalError || new Error('Native Harness host closed'));
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    await server?.close();
    onControl?.(null);
  }
}
