#!/usr/bin/env node

import {
  DEFAULT_ROOT_DIR,
  KNOWN_QUEUES,
  addAllowEntry,
  approveMessage,
  getMailboxStatus,
  initializeMailbox,
  ingestSource,
  listQueue,
  loadAllowlist,
  loadMailboxAutomation,
  loadOutboundConfig,
  mailboxPaths,
  queueCounts,
  saveMailboxAutomation,
  saveOutboundConfig,
  summarizeQueueItem,
} from '../lib/agent-mailbox.mjs';

function parseArgs(argv) {
  const positional = [];
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const key = token.slice(2);
    const nextToken = argv[index + 1];
    const value = !nextToken || nextToken.startsWith('--') ? true : nextToken;
    if (value !== true) {
      index += 1;
    }

    if (Object.prototype.hasOwnProperty.call(options, key)) {
      const existingValue = options[key];
      options[key] = Array.isArray(existingValue)
        ? [...existingValue, value]
        : [existingValue, value];
    } else {
      options[key] = value;
    }
  }

  return { positional, options };
}

function optionValue(options, key, fallbackValue = undefined) {
  const value = options[key];
  if (Array.isArray(value)) {
    return value[value.length - 1];
  }
  return value === undefined ? fallbackValue : value;
}

function optionList(options, key) {
  const value = options[key];
  if (value === undefined || value === true) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function optionBoolean(options, key, fallbackValue = undefined) {
  const value = optionValue(options, key, fallbackValue);
  if (value === undefined) {
    return fallbackValue;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallbackValue;
}

function printUsage() {
  console.log(`Usage:
  node scripts/agent-mail.mjs init --name <name> --local-part <localPart> --domain <domain> [--allow <email>] [--allow-domain <domain>]
  node scripts/agent-mail.mjs status [--root <dir>]
  node scripts/agent-mail.mjs allow add <email-or-domain> [--root <dir>]
  node scripts/agent-mail.mjs allow list [--root <dir>]
  node scripts/agent-mail.mjs ingest --source <file-or-dir> [--root <dir>]
  node scripts/agent-mail.mjs queue [review|quarantine|approved] [--root <dir>]
  node scripts/agent-mail.mjs approve <id> [--reviewer <name>] [--root <dir>]
  node scripts/agent-mail.mjs outbound status [--root <dir>]
  node scripts/agent-mail.mjs outbound configure-apple-mail [--account <name-or-email>] [--root <dir>]
  node scripts/agent-mail.mjs outbound configure-cloudflare-worker [--worker-base-url <url>] [--from <email>] [--worker-token <token>] [--worker-token-env <ENV>] [--root <dir>]
  node scripts/agent-mail.mjs automation status [--root <dir>]
  node scripts/agent-mail.mjs automation configure [--enabled <true|false>] [--allowlist-auto-approve <true|false>] [--auto-approve-reviewer <name>] [--chat-base-url <url>] [--folder <dir>] [--tool <tool>] [--group <name>] [--description <text>] [--system-prompt <text>] [--model <name>] [--effort <level>] [--thinking <true|false>] [--root <dir>]

Examples:
  node scripts/agent-mail.mjs init --name Rowan --local-part rowan --domain example.com --allow owner@example.com
  node scripts/agent-mail.mjs ingest --source /tmp/mail-samples
  node scripts/agent-mail.mjs queue review
  node scripts/agent-mail.mjs approve mail_123 --reviewer operator
  node scripts/agent-mail.mjs outbound configure-apple-mail --account Google
  node scripts/agent-mail.mjs outbound configure-cloudflare-worker --from agent@example.com --worker-base-url https://remotelab-email-worker.example.workers.dev
  node scripts/agent-mail.mjs automation configure --allowlist-auto-approve true --chat-base-url http://127.0.0.1:7690`);
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  const rootDir = optionValue(options, 'root', DEFAULT_ROOT_DIR);

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    return;
  }

  if (command === 'init') {
    const result = initializeMailbox({
      rootDir,
      name: optionValue(options, 'name'),
      localPart: optionValue(options, 'local-part'),
      domain: optionValue(options, 'domain'),
      description: optionValue(options, 'description'),
      allowEmails: optionList(options, 'allow'),
      allowDomains: optionList(options, 'allow-domain'),
    });

    console.log(`Initialized mailbox identity at ${mailboxPaths(rootDir).identityFile}`);
    printJson({
      identity: result.identity,
      allowlist: result.allowlist,
    });
    return;
  }

  if (command === 'status') {
    printJson(getMailboxStatus(rootDir));
    return;
  }

  if (command === 'allow') {
    const action = positional[1];
    if (action === 'add') {
      const entry = positional[2];
      if (!entry) {
        throw new Error('allow add requires an email address or domain');
      }
      const allowlist = addAllowEntry(entry, rootDir);
      console.log(`Updated allowlist at ${mailboxPaths(rootDir).allowlistFile}`);
      printJson(allowlist);
      return;
    }

    if (action === 'list') {
      printJson(loadAllowlist(rootDir));
      return;
    }

    throw new Error('allow requires a subcommand: add | list');
  }

  if (command === 'ingest') {
    const sourcePath = optionValue(options, 'source');
    if (!sourcePath) {
      throw new Error('ingest requires --source <file-or-dir>');
    }

    const ingestedItems = ingestSource(sourcePath, rootDir).map(summarizeQueueItem);
    printJson({
      ingested: ingestedItems,
      counts: queueCounts(rootDir),
    });
    return;
  }

  if (command === 'queue') {
    const queueName = positional[1] || 'review';
    if (!KNOWN_QUEUES.includes(queueName)) {
      throw new Error(`queue must be one of: ${KNOWN_QUEUES.join(', ')}`);
    }

    printJson(listQueue(queueName, rootDir).map(summarizeQueueItem));
    return;
  }

  if (command === 'approve') {
    const id = positional[1];
    if (!id) {
      throw new Error('approve requires an item id');
    }

    const reviewer = optionValue(options, 'reviewer', 'manual-operator');
    printJson(summarizeQueueItem(approveMessage(id, rootDir, reviewer)));
    return;
  }

  if (command === 'outbound') {
    const action = positional[1] || 'status';
    if (action === 'status') {
      printJson(getMailboxStatus(rootDir).outbound);
      return;
    }

    if (action === 'configure-apple-mail') {
      const current = loadOutboundConfig(rootDir);
      saveOutboundConfig(rootDir, {
        ...current,
        provider: 'apple_mail',
        account: optionValue(options, 'account', current.account),
        from: optionValue(options, 'from', ''),
      });
      console.log(`Updated outbound config at ${mailboxPaths(rootDir).outboundFile}`);
      printJson(getMailboxStatus(rootDir).outbound);
      return;
    }

    if (action === 'configure-cloudflare-worker') {
      const current = loadOutboundConfig(rootDir);
      saveOutboundConfig(rootDir, {
        ...current,
        provider: 'cloudflare_worker',
        workerBaseUrl: optionValue(options, 'worker-base-url', current.workerBaseUrl),
        from: optionValue(options, 'from', current.from),
        workerToken: optionValue(options, 'worker-token', current.workerToken),
        workerTokenEnv: optionValue(options, 'worker-token-env', current.workerTokenEnv),
      });
      console.log(`Updated outbound config at ${mailboxPaths(rootDir).outboundFile}`);
      printJson(getMailboxStatus(rootDir).outbound);
      return;
    }

    throw new Error('outbound requires a subcommand: status | configure-apple-mail | configure-cloudflare-worker');
  }

  if (command === 'automation') {
    const action = positional[1] || 'status';
    if (action === 'status') {
      printJson(loadMailboxAutomation(rootDir));
      return;
    }

    if (action === 'configure') {
      const current = loadMailboxAutomation(rootDir);
      const nextAutomation = saveMailboxAutomation(rootDir, {
        ...current,
        enabled: optionBoolean(options, 'enabled', current.enabled),
        allowlistAutoApprove: optionBoolean(options, 'allowlist-auto-approve', current.allowlistAutoApprove),
        autoApproveReviewer: optionValue(options, 'auto-approve-reviewer', current.autoApproveReviewer),
        chatBaseUrl: optionValue(options, 'chat-base-url', current.chatBaseUrl),
        session: {
          ...current.session,
          folder: optionValue(options, 'folder', current.session.folder),
          tool: optionValue(options, 'tool', current.session.tool),
          group: optionValue(options, 'group', current.session.group),
          description: optionValue(options, 'description', current.session.description),
          systemPrompt: optionValue(options, 'system-prompt', current.session.systemPrompt),
          model: optionValue(options, 'model', current.session.model),
          effort: optionValue(options, 'effort', current.session.effort),
          thinking: optionBoolean(options, 'thinking', current.session.thinking),
        },
      });
      console.log(`Updated automation config at ${mailboxPaths(rootDir).automationFile}`);
      printJson(nextAutomation);
      return;
    }

    throw new Error('automation requires a subcommand: status | configure');
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
