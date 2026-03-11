#!/usr/bin/env node
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const require = createRequire(import.meta.url);
const pkg = require('./package.json');

const [,, command, ...args] = process.argv;

function scriptPath(name) {
  return path.join(__dirname, name);
}

function runShell(script) {
  try {
    execFileSync('bash', [scriptPath(script)], { stdio: 'inherit' });
  } catch (err) {
    process.exit(err.status ?? 1);
  }
}

function printHelp() {
  console.log(`remotelab v${pkg.version}

Usage:
  remotelab setup                    Run interactive setup
  remotelab start                    Start all services
  remotelab stop                     Stop all services
  remotelab restart [service]        Restart services (chat|tunnel|all)
  remotelab chat                     Run chat server in foreground
  remotelab generate-token           Generate a new access token
  remotelab set-password             Set username & password for login
  remotelab --help                   Show this help message
  remotelab --version                Show version`);
}

switch (command) {
  case 'setup':
    runShell('setup.sh');
    break;

  case 'start':
    runShell('start.sh');
    break;

  case 'stop':
    runShell('stop.sh');
    break;

  case 'restart': {
    const service = args[0] || 'all';
    try {
      execFileSync('bash', [scriptPath('restart.sh'), service], { stdio: 'inherit' });
    } catch (err) {
      process.exit(err.status ?? 1);
    }
    break;
  }

  case 'chat':
    await import(scriptPath('chat-server.mjs'));
    break;

  case 'generate-token': {
    try {
      execFileSync('node', [scriptPath('generate-token.mjs')], { stdio: 'inherit' });
    } catch (err) {
      process.exit(err.status ?? 1);
    }
    break;
  }

  case 'set-password': {
    await import(scriptPath('set-password.mjs'));
    break;
  }

  case '--version':
  case '-v':
    console.log(pkg.version);
    break;

  case '--help':
  case '-h':
  case undefined:
    printHelp();
    break;

  default:
    console.error(`Unknown command: ${command}`);
    console.error('Run "remotelab --help" for usage.');
    process.exit(1);
}
