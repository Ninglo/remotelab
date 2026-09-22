import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createNativeInputServer } from './native-input-transport.mjs';
import { createCodexDriver } from './native/codex.mjs';
import { createPiDriver } from './native/pi.mjs';
import { createClaudeDriver } from './native/claude.mjs';
import { createAntigravityDriver } from './native/antigravity.mjs';
import {
  classifySessionStartPreflightAnswer,
  createSessionStartPreflightCapture,
} from './session-start-preflight.mjs';

const factories = {
  'codex-json': createCodexDriver,
  'pi-json': createPiDriver,
  'claude-stream-json': createClaudeDriver,
  'antigravity-stream-json': createAntigravityDriver,
};

function createLfLineReader(stream, onLine) {
  let buffer = '';
  stream.setEncoding('utf8');
  const closed = new Promise((resolve, reject) => {
    stream.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        onLine(line);
      }
    });
    stream.once('end', () => {
      if (buffer) onLine(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
      resolve();
    });
    stream.once('error', reject);
  });
  return { closed };
}

// The detached sidecar owns the bidirectional native process. The controller
// can disappear without closing stdin or losing the Harness's active tools.
export async function runNativeHost({ directory, command, runtimeFamily, options, prompt, cwd, env, onStdout, onStderr, onProcess, onControl, isCancelled = async () => false, startPreflight = null, onPreflightResult = async () => {} }) {
  const createDriver = factories[runtimeFamily];
  if (!createDriver) throw new Error(`Unsupported native Harness ${runtimeFamily}`);
  const preflight = startPreflight?.prompt
    ? {
      prompt: String(startPreflight.prompt),
      restartAnswers: Array.isArray(startPreflight.restartAnswers) ? startPreflight.restartAnswers : [],
    }
    : null;
  const preflightCapture = preflight ? createSessionStartPreflightCapture(runtimeFamily) : null;
  let proc;
  let server;
  let started = false;
  let acceptingExternalInputs = !preflight;
  let closing = false;
  let interruptRequested = false;
  let nativeResult = null;
  let settlementRevision = 0;
  let fatalError = null;
  let submissions = 0;
  let closeTimer;
  let killTimer;
  let phase = preflight ? 'preflight' : 'main';
  let preflightResult = null;
  let phaseTransition = Promise.resolve();
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
  const emit = event => queueWrite(() => onStdout(JSON.stringify(event)));
  const driver = createDriver({ options, cwd,
    send: message => {
      if (!proc || proc.stdin.destroyed || closing) throw Object.assign(new Error('Native Harness input channel is closed'), { code: 'NATIVE_UNCERTAIN' });
      proc.stdin.write(`${JSON.stringify(message)}\n`);
    },
    onEvent: event => {
      if (phase === 'preflight') {
        preflightCapture.observe(event);
        return;
      }
      emit(event);
    },
    onSettled: result => {
      settlementRevision++;
      if (phase !== 'preflight') {
        nativeResult = result || { status: 'completed' };
        queueMicrotask(maybeStop);
        return;
      }
      phase = 'preflight_settling';
      submissions++;
      phaseTransition = Promise.resolve().then(async () => {
        if (result?.status === 'failed') {
          preflightResult = {
            status: 'error',
            answer: preflightCapture.answer(),
            reason: 'provider_turn_failed',
            error: result.error?.message || result.error || 'Session start preflight failed',
            checkedAt: new Date().toISOString(),
          };
          await onPreflightResult(preflightResult);
          nativeResult = { status: 'failed', error: preflightResult.error };
          return;
        }
        preflightResult = {
          ...classifySessionStartPreflightAnswer(preflightCapture.answer(), preflight),
          checkedAt: new Date().toISOString(),
        };
        await onPreflightResult(preflightResult);
        if (preflightResult.status !== 'loaded') {
          nativeResult = preflightResult.status === 'restart_required'
            ? { status: 'preflight_restart_required' }
            : { status: 'failed', error: 'Session start preflight returned no usable answer' };
          return;
        }
        const providerIdentityEvent = preflightCapture.providerIdentityEvent();
        if (providerIdentityEvent) emit(providerIdentityEvent);
        phase = 'main';
        nativeResult = null;
        const receipt = await driver.submit({ id: options.requestId, text: prompt });
        acceptingExternalInputs = receipt?.accepted === true;
      }).catch((error) => {
        fatalError ||= error instanceof Error ? error : new Error(String(error?.message || error));
        nativeResult = { status: 'failed', error: fatalError.message };
      }).finally(() => {
        submissions--;
        queueMicrotask(maybeStop);
      });
    },
    onError: error => { fatalError ||= error instanceof Error ? error : new Error(String(error?.message || error)); stop(); },
  });
  proc = spawn(command, driver.args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => {
    proc.once('error', error => { fatalError ||= error; });
    proc.once('close', (code, signal) => resolve({ code, signal }));
  });
  proc.stdin.on('error', error => { if (!closing) { fatalError ||= error; stop(); } });
  // App Server speaks JSONL, whose record separator is LF. Node's readline
  // also splits on the valid JSON string characters U+2028 and U+2029, which
  // corrupts frames when tool output contains copied web or document text.
  const stdout = createLfLineReader(proc.stdout, line => {
    try { driver.handle(JSON.parse(line)); }
    catch (error) { fatalError ||= error; stop(); }
  });
  const stderr = createInterface({ input: proc.stderr });
  const readersClosed = Promise.all([
    stdout.closed,
    new Promise(resolve => stderr.once('close', resolve)),
  ]);
  const stderrLines = [];
  stderr.on('line', line => { stderrLines.push(line); queueWrite(() => onStderr(line)); });
  try {
    await onProcess(proc);
    onControl?.({ interrupt: () => { interruptRequested = true; return driver.interrupt(); } });
    // The endpoint becomes visible before starting the first model call. It
    // accepts follow-ups as soon as the protocol initialization has completed.
    server = await createNativeInputServer({ directory,
      isAccepting: async () => { const cancelled = await isCancelled(); return started && acceptingExternalInputs && !closing && !interruptRequested && !cancelled; },
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
    const initial = driver.start(preflight?.prompt || prompt);
    // Drivers perform their own handshake gating. Their start promise is a
    // reception receipt and must not block accepting further stdin messages.
    started = true;
    if (!preflight) initial.then((receipt) => { acceptingExternalInputs = receipt?.accepted === true; }).catch(() => {});
    initial.catch(error => { fatalError ||= error; stop(); });
    const exit = await closed;
    await phaseTransition;
    driver.close(fatalError || new Error('Native Harness process exited'));
    await readersClosed;
    await writes;
    const failed = fatalError || writeError || (nativeResult?.status === 'failed' ? new Error(nativeResult.error?.message || nativeResult.error || 'Native Harness turn failed') : null);
    return { code: failed ? 1 : nativeResult ? 0 : (exit.code ?? 1), signal: nativeResult ? null : exit.signal,
      error: failed || (!nativeResult ? new Error('Native Harness exited before reporting completion') : null), stderrText: stderrLines.join('\n'),
      ...(preflightResult ? { preflight: preflightResult } : {}) };
  } finally {
    clearTimeout(closeTimer); clearTimeout(killTimer);
    driver.close(fatalError || new Error('Native Harness host closed'));
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    await server?.close();
    onControl?.(null);
  }
}
