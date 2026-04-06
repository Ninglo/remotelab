import { readFile } from 'fs/promises';

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
  loadIdentity,
  loadMailboxAutomation,
  loadOutboundConfig,
  mailboxPaths,
  queueCounts,
  saveMailboxAutomation,
  saveOutboundConfig,
  summarizeQueueItem,
} from './agent-mailbox.mjs';
import { sendOutboundEmail } from './agent-mail-outbound.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const trimmed = trimString(value);
    if (trimmed) return trimmed;
  }
  return '';
}

function parseArgs(argv = []) {
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

function writeText(stdout, text = '') {
  stdout.write(`${text}\n`);
}

function writeJson(stdout, value) {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printUsage(stdout = process.stdout) {
  stdout.write(`Usage:\n  remotelab mail init --name <name> --local-part <localPart> --domain <domain> [--instance-address-mode <plus|local_part>] [--allow <email>] [--allow-domain <domain>]\n  remotelab mail status [--root <dir>]\n  remotelab mail allow add <email-or-domain> [--root <dir>]\n  remotelab mail allow list [--root <dir>]\n  remotelab mail ingest --source <file-or-dir> [--root <dir>]\n  remotelab mail queue [review|quarantine|approved] [--root <dir>]\n  remotelab mail approve <id> [--reviewer <name>] [--root <dir>]\n  remotelab mail send --to <email> [--to <email> ...] [--subject <text>] [--text <body> | --text-file <path> | --stdin] [--from <email>] [--in-reply-to <message-id>] [--references <message-ids>] [--root <dir>] [--json]\n  remotelab mail outbound status [--root <dir>]\n  remotelab mail outbound configure-apple-mail [--account <name-or-email>] [--from <email>] [--root <dir>]\n  remotelab mail outbound configure-cloudflare-worker [--worker-base-url <url>] [--from <email>] [--worker-token <token>] [--worker-token-env <ENV>] [--root <dir>]\n  remotelab mail outbound configure-resend-api [--api-base-url <url>] [--from <email>] [--api-key <token>] [--api-key-env <ENV>] [--reply-to <email>] [--root <dir>]\n  remotelab mail automation status [--root <dir>]\n  remotelab mail automation configure [--enabled <true|false>] [--allowlist-auto-approve <true|false>] [--auto-approve-reviewer <name>] [--chat-base-url <url>] [--auth-file <path>] [--delivery-mode <reply_email|session_only>] [--folder <dir>] [--tool <tool>] [--group <name>] [--description <text>] [--system-prompt <text>] [--model <name>] [--effort <level>] [--thinking <true|false>] [--root <dir>]\n\nExamples:\n  remotelab mail send --to owner@example.com --subject "RemoteLab test" --text "hello from RemoteLab"\n  cat draft.txt | remotelab mail send --to owner@example.com --subject "Weekly update" --stdin\n  remotelab mail outbound configure-resend-api --from agent@example.com --api-key-env RESEND_API_KEY\n  remotelab mail outbound configure-cloudflare-worker --from agent@example.com --worker-base-url https://remotelab-email-worker.example.workers.dev\n\nDirect script entry remains supported via:\n  node scripts/agent-mail.mjs ...\n`);
}

function summarizeSendResult(result = {}, message = {}) {
  return {
    provider: trimString(result?.provider),
    requestedProvider: trimString(result?.requestedProvider),
    fallbackFromProvider: trimString(result?.fallbackFromProvider),
    fallbackReason: trimString(result?.fallbackReason),
    statusCode: Number.isInteger(result?.statusCode) ? result.statusCode : null,
    responseId: firstNonEmpty(result?.summary?.id, result?.response?.id, result?.response?.messageId),
    responseMessage: firstNonEmpty(result?.summary?.message, result?.response?.message),
    to: Array.isArray(message.to) ? message.to.map((value) => trimString(value)).filter(Boolean) : [],
    from: trimString(message.from),
    subject: trimString(message.subject),
  };
}

function writeSendResult(stdout, summary = {}, json = false) {
  if (json) {
    writeJson(stdout, summary);
    return;
  }

  const lines = [
    `provider: ${trimString(summary.provider)}`,
    `statusCode: ${summary.statusCode ?? ''}`,
    `to: ${(summary.to || []).join(', ')}`,
    `from: ${trimString(summary.from)}`,
    `subject: ${trimString(summary.subject)}`,
  ];
  if (trimString(summary.responseId)) {
    lines.push(`responseId: ${trimString(summary.responseId)}`);
  }
  if (trimString(summary.responseMessage)) {
    lines.push(`responseMessage: ${trimString(summary.responseMessage)}`);
  }
  if (trimString(summary.requestedProvider) && trimString(summary.requestedProvider) !== trimString(summary.provider)) {
    lines.push(`requestedProvider: ${trimString(summary.requestedProvider)}`);
  }
  if (trimString(summary.fallbackFromProvider)) {
    lines.push(`fallbackFromProvider: ${trimString(summary.fallbackFromProvider)}`);
  }
  if (trimString(summary.fallbackReason)) {
    lines.push(`fallbackReason: ${trimString(summary.fallbackReason)}`);
  }
  writeText(stdout, lines.join('\n'));
}

async function readAllFromStdin(stdin = process.stdin) {
  return new Promise((resolve, reject) => {
    let text = '';
    stdin.setEncoding?.('utf8');
    stdin.on('data', (chunk) => {
      text += String(chunk);
    });
    stdin.on('end', () => resolve(text));
    stdin.on('error', reject);
  });
}

async function resolveSendBody(options, io = {}) {
  const inlineText = optionValue(options, 'text');
  const textFile = trimString(optionValue(options, 'text-file'));
  const useStdin = optionBoolean(options, 'stdin', false) === true;
  const specifiedSourceCount = [
    typeof inlineText === 'string',
    Boolean(textFile),
    useStdin,
  ].filter(Boolean).length;

  if (specifiedSourceCount === 0) {
    throw new Error('send requires one of --text, --text-file, or --stdin');
  }
  if (specifiedSourceCount > 1) {
    throw new Error('send accepts only one body source: --text, --text-file, or --stdin');
  }

  if (typeof inlineText === 'string') {
    return inlineText;
  }
  if (textFile) {
    return await readFile(textFile, 'utf8');
  }
  return readAllFromStdin(io.stdin || process.stdin);
}

async function handleSend(options, rootDir, io = {}) {
  const stdout = io.stdout || process.stdout;
  const to = optionList(options, 'to').map((value) => trimString(value)).filter(Boolean);
  if (to.length === 0) {
    throw new Error('send requires at least one --to <email>');
  }

  const outboundConfig = await loadOutboundConfig(rootDir);
  const identity = await loadIdentity(rootDir);
  const message = {
    to,
    from: firstNonEmpty(optionValue(options, 'from'), outboundConfig.from, identity?.address),
    subject: trimString(optionValue(options, 'subject')),
    text: await resolveSendBody(options, io),
    inReplyTo: trimString(optionValue(options, 'in-reply-to')),
    references: trimString(optionValue(options, 'references')),
  };
  const delivery = await sendOutboundEmail(message, outboundConfig);
  const summary = summarizeSendResult(delivery, message);
  writeSendResult(stdout, summary, optionBoolean(options, 'json', false) === true);
  return 0;
}

export async function runAgentMailCommand(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  const { positional, options } = parseArgs(argv);
  const command = positional[0];
  const rootDir = optionValue(options, 'root', DEFAULT_ROOT_DIR);

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printUsage(stdout);
    return 0;
  }

  if (command === 'init') {
    const result = await initializeMailbox({
      rootDir,
      name: optionValue(options, 'name'),
      localPart: optionValue(options, 'local-part'),
      domain: optionValue(options, 'domain'),
      description: optionValue(options, 'description'),
      instanceAddressMode: optionValue(options, 'instance-address-mode'),
      allowEmails: optionList(options, 'allow'),
      allowDomains: optionList(options, 'allow-domain'),
    });
    writeText(stdout, `Initialized mailbox at ${mailboxPaths(rootDir).rootDir}`);
    writeJson(stdout, result);
    return 0;
  }

  if (command === 'status') {
    writeJson(stdout, await getMailboxStatus(rootDir));
    return 0;
  }

  if (command === 'allow') {
    const action = positional[1];
    if (action === 'add') {
      const entry = positional[2];
      if (!entry) {
        throw new Error('allow add requires an email address or domain');
      }
      const allowlist = await addAllowEntry(entry, rootDir);
      writeText(stdout, `Updated allowlist at ${mailboxPaths(rootDir).allowlistFile}`);
      writeJson(stdout, allowlist);
      return 0;
    }

    if (action === 'list') {
      writeJson(stdout, await loadAllowlist(rootDir));
      return 0;
    }

    throw new Error('allow requires a subcommand: add | list');
  }

  if (command === 'ingest') {
    const sourcePath = optionValue(options, 'source');
    if (!sourcePath) {
      throw new Error('ingest requires --source <file-or-dir>');
    }

    const ingestedItems = (await ingestSource(sourcePath, rootDir)).map(summarizeQueueItem);
    writeJson(stdout, {
      ingested: ingestedItems,
      counts: await queueCounts(rootDir),
    });
    return 0;
  }

  if (command === 'queue') {
    const queueName = positional[1] || 'review';
    if (!KNOWN_QUEUES.includes(queueName)) {
      throw new Error(`queue must be one of: ${KNOWN_QUEUES.join(', ')}`);
    }

    writeJson(stdout, (await listQueue(queueName, rootDir)).map(summarizeQueueItem));
    return 0;
  }

  if (command === 'approve') {
    const id = positional[1];
    if (!id) {
      throw new Error('approve requires an item id');
    }

    const reviewer = optionValue(options, 'reviewer', 'manual-operator');
    writeJson(stdout, summarizeQueueItem(await approveMessage(id, rootDir, reviewer)));
    return 0;
  }

  if (command === 'send') {
    return handleSend(options, rootDir, io);
  }

  if (command === 'outbound') {
    const action = positional[1] || 'status';
    if (action === 'status') {
      writeJson(stdout, (await getMailboxStatus(rootDir)).outbound);
      return 0;
    }

    if (action === 'configure-apple-mail') {
      const current = await loadOutboundConfig(rootDir);
      await saveOutboundConfig(rootDir, {
        ...current,
        provider: 'apple_mail',
        account: optionValue(options, 'account', current.account),
        from: optionValue(options, 'from', current.from),
      });
      writeText(stdout, `Updated outbound config at ${mailboxPaths(rootDir).outboundFile}`);
      writeJson(stdout, (await getMailboxStatus(rootDir)).outbound);
      return 0;
    }

    if (action === 'configure-cloudflare-worker') {
      const current = await loadOutboundConfig(rootDir);
      await saveOutboundConfig(rootDir, {
        ...current,
        provider: 'cloudflare_worker',
        workerBaseUrl: optionValue(options, 'worker-base-url', current.workerBaseUrl),
        from: optionValue(options, 'from', current.from),
        workerToken: optionValue(options, 'worker-token', current.workerToken),
        workerTokenEnv: optionValue(options, 'worker-token-env', current.workerTokenEnv),
      });
      writeText(stdout, `Updated outbound config at ${mailboxPaths(rootDir).outboundFile}`);
      writeJson(stdout, (await getMailboxStatus(rootDir)).outbound);
      return 0;
    }

    if (action === 'configure-resend-api') {
      const current = await loadOutboundConfig(rootDir);
      await saveOutboundConfig(rootDir, {
        ...current,
        provider: 'resend_api',
        apiBaseUrl: optionValue(options, 'api-base-url', current.apiBaseUrl),
        from: optionValue(options, 'from', current.from),
        apiKey: optionValue(options, 'api-key', current.apiKey),
        apiKeyEnv: optionValue(options, 'api-key-env', current.apiKeyEnv || 'RESEND_API_KEY'),
        replyTo: optionValue(options, 'reply-to', current.replyTo),
      });
      writeText(stdout, `Updated outbound config at ${mailboxPaths(rootDir).outboundFile}`);
      writeJson(stdout, (await getMailboxStatus(rootDir)).outbound);
      return 0;
    }

    throw new Error('outbound requires a subcommand: status | configure-apple-mail | configure-cloudflare-worker | configure-resend-api');
  }

  if (command === 'automation') {
    const action = positional[1] || 'status';
    if (action === 'status') {
      writeJson(stdout, await loadMailboxAutomation(rootDir));
      return 0;
    }

    if (action === 'configure') {
      const current = await loadMailboxAutomation(rootDir);
      const nextAutomation = await saveMailboxAutomation(rootDir, {
        ...current,
        enabled: optionBoolean(options, 'enabled', current.enabled),
        allowlistAutoApprove: optionBoolean(options, 'allowlist-auto-approve', current.allowlistAutoApprove),
        autoApproveReviewer: optionValue(options, 'auto-approve-reviewer', current.autoApproveReviewer),
        chatBaseUrl: optionValue(options, 'chat-base-url', current.chatBaseUrl),
        authFile: optionValue(options, 'auth-file', current.authFile),
        deliveryMode: optionValue(options, 'delivery-mode', current.deliveryMode),
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
      writeText(stdout, `Updated automation config at ${mailboxPaths(rootDir).automationFile}`);
      writeJson(stdout, nextAutomation);
      return 0;
    }

    throw new Error('automation requires a subcommand: status | configure');
  }

  throw new Error(`Unknown command: ${command}`);
}
