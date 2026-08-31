import { readFile } from 'fs/promises';

import { resolveGmailConnectorBinding } from './connector-bindings.mjs';
import {
  DEFAULT_GMAIL_BINDING_ID,
  archiveGmailThread,
  getGmailProfile,
  gmailCredentialsPresent,
  labelGmailThread,
  markGmailThreadRead,
  readGmailResource,
  replyToGmailThread,
  resolveGmailCredentialsPath,
  searchGmailThreads,
  sendGmailMessage,
} from './connector-gmail.mjs';

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

function optionValue(options, name, fallback = '') {
  return Object.prototype.hasOwnProperty.call(options, name) ? options[name] : fallback;
}

function optionBoolean(options, name, fallback = false) {
  if (!Object.prototype.hasOwnProperty.call(options, name)) return fallback;
  const value = options[name];
  if (value === true || value === false) return value;
  const normalized = trimString(String(value)).toLowerCase();
  if (!normalized) return true;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function optionList(options, name) {
  const value = options[name];
  if (Array.isArray(value)) return value.map((entry) => trimString(entry)).filter(Boolean);
  const single = trimString(value);
  return single ? [single] : [];
}

function appendOption(options, key, value) {
  if (!Object.prototype.hasOwnProperty.call(options, key)) {
    options[key] = value;
    return;
  }
  if (!Array.isArray(options[key])) {
    options[key] = [options[key]];
  }
  options[key].push(value);
}

function parseArgs(argv = []) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      options[name] = true;
      continue;
    }
    appendOption(options, name, next);
    index += 1;
  }
  return { positional, options };
}

function printHelp(stdout = process.stdout) {
  stdout.write(`Usage:
  remotelab gmail status [--binding <id>] [--json]
  remotelab gmail profile [--binding <id>] [--json]
  remotelab gmail search --query <text> [--max-results <n>] [--binding <id>] [--json]
  remotelab gmail read (--url <gmail-url> | --thread-id <id> | --message-id <id>) [--binding <id>] [--json]
  remotelab gmail archive (--url <gmail-url> | --thread-id <id> | --message-id <id>) [--binding <id>] [--json]
  remotelab gmail mark-read (--url <gmail-url> | --thread-id <id> | --message-id <id>) [--binding <id>] [--json]
  remotelab gmail mark-unread (--url <gmail-url> | --thread-id <id> | --message-id <id>) [--binding <id>] [--json]
  remotelab gmail label (--url <gmail-url> | --thread-id <id> | --message-id <id>) [--add <label>] [--remove <label>] [--binding <id>] [--json]
  remotelab gmail reply (--url <gmail-url> | --thread-id <id> | --message-id <id>) (--text <body> | --text-file <path> | --stdin) [--draft] [--binding <id>] [--json]
  remotelab gmail send --as-user --to <email> [--to <email> ...] --subject <text> (--text <body> | --text-file <path> | --stdin) [--cc <email>] [--bcc <email>] [--draft] [--binding <id>] [--json]

Notes:
  - Gmail authorization is managed through the RemoteLab connector UI at /connectors/gmail
  - The default binding id is ${DEFAULT_GMAIL_BINDING_ID}
  - Gmail send uses the connected user's identity and therefore requires explicit --as-user acknowledgement. Use remotelab mail send for assistant-originated mail.
  - Prefer --json when using this command from an AI agent
  - --text is literal and intended for single-line bodies. For line breaks, use --text-file or --stdin instead of typing \\n escape sequences.
`);
}

async function resolveBodyText(options) {
  const direct = optionValue(options, 'text');
  if (trimString(direct)) return trimString(direct);
  const textFile = optionValue(options, 'text-file');
  if (trimString(textFile)) {
    return (await readFile(trimString(textFile), 'utf8')).trim();
  }
  if (optionBoolean(options, 'stdin', false)) {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  return '';
}

function buildTargetArgs(options) {
  return {
    url: optionValue(options, 'url'),
    threadId: optionValue(options, 'thread-id'),
    messageId: optionValue(options, 'message-id'),
  };
}

function writePayload(stdout, payload, json = false) {
  if (json) {
    stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  if (payload?.message) {
    const message = payload.message;
    stdout.write([
      `kind: message`,
      `subject: ${message.subject || ''}`,
      `from: ${message.from || ''}`,
      `date: ${message.date || ''}`,
      '',
      message.text || message.snippet || '',
    ].join('\n').trim() + '\n');
    return;
  }

  if (payload?.thread) {
    const latest = payload.thread.latestMessage || {};
    stdout.write([
      `kind: thread`,
      `threadId: ${payload.thread.id || ''}`,
      `subject: ${latest.subject || payload.thread.subject || ''}`,
      `from: ${latest.from || payload.thread.from || ''}`,
      `date: ${latest.date || payload.thread.date || ''}`,
      '',
      latest.text || latest.snippet || payload.thread.snippet || '',
    ].join('\n').trim() + '\n');
    return;
  }

  if (Array.isArray(payload?.items)) {
    const blocks = payload.items.map((item) => [
      `threadId: ${item.id || ''}`,
      `subject: ${item.subject || ''}`,
      `from: ${item.from || ''}`,
      `date: ${item.date || ''}`,
      `messages: ${item.messageCount || 0}`,
      `snippet: ${item.snippet || ''}`,
    ].join('\n'));
    stdout.write(`${blocks.join('\n\n')}\n`);
    return;
  }

  stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

export async function runGmailCommand(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  const { positional, options } = parseArgs(argv);
  const command = trimString(positional[0]).toLowerCase();
  const bindingId = trimString(optionValue(options, 'binding')) || DEFAULT_GMAIL_BINDING_ID;
  const json = optionBoolean(options, 'json', false);

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp(stdout);
    return 0;
  }

  if (command === 'status') {
    const binding = await resolveGmailConnectorBinding({ bindingId });
    let credentialsPath = '';
    let credentialsPresent = false;
    let setupError = '';
    try {
      credentialsPath = await resolveGmailCredentialsPath();
      credentialsPresent = await gmailCredentialsPresent(credentialsPath);
    } catch (error) {
      setupError = firstNonEmpty(error?.message, 'Google OAuth credentials are invalid.');
    }
    writePayload(stdout, {
      bindingId,
      credentialsPath,
      credentialsPresent,
      setupError,
      connectPath: '/connectors/gmail',
      binding,
    }, json);
    return 0;
  }

  if (command === 'profile') {
    writePayload(stdout, await getGmailProfile({ bindingId }), json);
    return 0;
  }

  if (command === 'search') {
    const query = trimString(optionValue(options, 'query'));
    if (!query) throw new Error('search requires --query <text>');
    writePayload(stdout, await searchGmailThreads({
      bindingId,
      query,
      maxResults: optionValue(options, 'max-results'),
    }), json);
    return 0;
  }

  if (command === 'read') {
    writePayload(stdout, await readGmailResource({
      bindingId,
      ...buildTargetArgs(options),
    }), json);
    return 0;
  }

  if (command === 'archive') {
    writePayload(stdout, await archiveGmailThread({
      bindingId,
      ...buildTargetArgs(options),
    }), json);
    return 0;
  }

  if (command === 'mark-read' || command === 'mark-unread') {
    writePayload(stdout, await markGmailThreadRead({
      bindingId,
      unread: command === 'mark-unread',
      ...buildTargetArgs(options),
    }), json);
    return 0;
  }

  if (command === 'label') {
    const addLabels = optionList(options, 'add');
    const removeLabels = optionList(options, 'remove');
    if (addLabels.length === 0 && removeLabels.length === 0) {
      throw new Error('label requires at least one --add <label> or --remove <label>');
    }
    writePayload(stdout, await labelGmailThread({
      bindingId,
      addLabels,
      removeLabels,
      ...buildTargetArgs(options),
    }), json);
    return 0;
  }

  if (command === 'reply') {
    const text = await resolveBodyText(options);
    if (!text) throw new Error('reply requires --text <body>, --text-file <path>, or --stdin');
    writePayload(stdout, await replyToGmailThread({
      bindingId,
      draft: optionBoolean(options, 'draft', false),
      text,
      ...buildTargetArgs(options),
    }), json);
    return 0;
  }

  if (command === 'send') {
    if (!optionBoolean(options, 'as-user', false)) {
      throw new Error('gmail send requires --as-user because it sends from the connected user identity; use remotelab mail send for assistant-originated mail');
    }
    const text = await resolveBodyText(options);
    const to = optionList(options, 'to');
    const subject = firstNonEmpty(optionValue(options, 'subject'));
    if (to.length === 0) throw new Error('send requires at least one --to <email>');
    if (!subject) throw new Error('send requires --subject <text>');
    if (!text) throw new Error('send requires --text <body>, --text-file <path>, or --stdin');
    writePayload(stdout, await sendGmailMessage({
      bindingId,
      to,
      cc: optionList(options, 'cc'),
      bcc: optionList(options, 'bcc'),
      subject,
      text,
      draft: optionBoolean(options, 'draft', false),
    }), json);
    return 0;
  }

  throw new Error(`Unknown gmail subcommand: ${command}`);
}
