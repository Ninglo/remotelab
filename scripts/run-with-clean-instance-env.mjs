#!/usr/bin/env node
import { spawn } from 'child_process';

const [, , ...args] = process.argv;

if (args.length === 0) {
  console.error('Usage: node scripts/run-with-clean-instance-env.mjs <command> [args...]');
  process.exit(1);
}

const env = { ...process.env };
delete env.REMOTELAB_INSTANCE_ROOT;
delete env.REMOTELAB_CONFIG_DIR;
delete env.REMOTELAB_MEMORY_DIR;

const child = spawn(args[0], args.slice(1), {
  stdio: 'inherit',
  env,
  shell: false,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on('error', (error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
