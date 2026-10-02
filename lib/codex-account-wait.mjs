import { watch } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

// Subscribe before checking the lock files so a release between admission and
// waiting cannot be lost. The timeout also handles cancellation and platforms
// whose filesystem notifications are unavailable or incomplete.
export async function waitForCodexAccountChange(queueDirs, configDir) {
  let wake;
  const changed = new Promise(resolve => { wake = resolve; });
  const watchers = [];
  const timeout = setTimeout(wake, 2000);
  const observe = (directory, onChange = wake) => {
    try {
      const watcher = watch(directory, { persistent: false }, onChange);
      watcher.on('error', wake);
      watchers.push(watcher);
    } catch { /* The bounded retry still observes cancellation and releases. */ }
  };
  try {
    observe(configDir, (_event, name) => {
      if (String(name) === 'accounts.json') wake();
    });
    for (const directory of queueDirs) observe(directory);
    await Promise.all(queueDirs.map(async directory => {
      try { await stat(join(directory, 'active.lock')); }
      catch (error) { if (error.code === 'ENOENT') wake(); }
    }));
    await changed;
  } finally {
    clearTimeout(timeout);
    for (const watcher of watchers) watcher.close();
  }
}
