import { codexAccounts } from '../lib/codex-accounts.mjs';
import { resolveToolCommandPathAsync } from '../lib/tools.mjs';

export async function pollCodexAccounts({ pool = codexAccounts,
  resolveCommand = () => resolveToolCommandPathAsync('codex') } = {}) {
  const data = await pool.read();
  if (!data.autoSwitch || data.accounts.length < 2) return;
  const command = await resolveCommand();
  if (command) await pool.list({ refresh: 'stale', command });
}

// Optional quota work runs outside HTTP admission and foreground execution.
// Fresh samples from native turns or fleet monitoring are reused.
export function startCodexAccountMonitor(options = {}) {
  let pending = false, stopped = false;
  const poll = async () => {
    if (pending || stopped) return;
    pending = true;
    try { await pollCodexAccounts(options); }
    catch { /* Keep dated quota visible; retry on the next background cycle. */ }
    finally { pending = false; }
  };
  const timer = setInterval(() => void poll(), 30_000);
  timer.unref?.();
  void poll();
  return () => { stopped = true; clearInterval(timer); };
}
