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
  remotelab restart [service]        Restart services (chat|tunnel|mainland|all)
  remotelab guest-instance           Create isolated guest instances on this machine
  remotelab chat                     Run chat server in foreground
  remotelab api                      Call the local RemoteLab HTTP API with owner auth
  remotelab mail                     Manage agent mailbox and send outbound email
  remotelab assistant-message        Append an assistant message with optional local-file attachments
  remotelab trigger                  Manage durable session triggers
  remotelab usage-summary            Summarize local Codex token usage
  remotelab session-spawn            Spawn a focused parallel session from a source session
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

  case 'release': {
    console.error('`remotelab release` has been removed. RemoteLab now runs the current source tree after restart. Use `remotelab restart chat` for the owner surface.');
    process.exit(1);
    break;
  }

  case 'guest-instance':
  case 'guest-instances': {
    const { runGuestInstanceCommand } = await import(scriptPath('lib/guest-instance-command.mjs'));
    try {
      process.exitCode = await runGuestInstanceCommand(args);
    } catch (error) {
      console.error(error.message || String(error));
      process.exit(1);
    }
    break;
  }

  case 'api': {
    const { runRemoteLabApiCommand } = await import(scriptPath('lib/remotelab-api-command.mjs'));
    try {
      process.exitCode = await runRemoteLabApiCommand(args);
    } catch (error) {
      console.error(error.message || String(error));
      process.exit(1);
    }
    break;
  }

  case 'mail':
  case 'email': {
    const { runAgentMailCommand } = await import(scriptPath('lib/agent-mail-command.mjs'));
    try {
      process.exitCode = await runAgentMailCommand(args);
    } catch (error) {
      console.error(error.message || String(error));
      process.exit(1);
    }
    break;
  }

  case 'assistant-message':
  case 'assistant-messages': {
    const { runAssistantMessageCommand } = await import(scriptPath('lib/assistant-message-command.mjs'));
    try {
      process.exitCode = await runAssistantMessageCommand(args);
    } catch (error) {
      console.error(error.message || String(error));
      process.exit(1);
    }
    break;
  }

  case 'trigger':
  case 'triggers': {
    const { runTriggerCommand } = await import(scriptPath('lib/trigger-command.mjs'));
    try {
      process.exitCode = await runTriggerCommand(args);
    } catch (error) {
      console.error(error.message || String(error));
      process.exit(1);
    }
    break;
  }

  case 'usage-summary': {
    const { runUsageSummaryCommand } = await import(scriptPath('lib/usage-summary-command.mjs'));
    try {
      process.exitCode = await runUsageSummaryCommand(args);
    } catch (error) {
      console.error(error.message || String(error));
      process.exit(1);
    }
    break;
  }

  case 'session-spawn':
  case 'spawn-session': {
    const { runSessionSpawnCommand } = await import(scriptPath('lib/session-spawn-command.mjs'));
    try {
      process.exitCode = await runSessionSpawnCommand(args);
    } catch (error) {
      console.error(error.message || String(error));
      process.exit(1);
    }
    break;
  }

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
