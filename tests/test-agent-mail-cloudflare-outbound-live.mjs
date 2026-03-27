#!/usr/bin/env node
import assert from 'assert/strict';

import { loadOutboundConfig } from '../lib/agent-mailbox.mjs';
import { sendOutboundEmail } from '../lib/agent-mail-outbound.mjs';
import {
  buildStatusSummary,
  enrichStatusWithLiveCloudflareState,
} from '../scripts/agent-mail-cloudflare-routing.mjs';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function emailDomain(address) {
  const normalized = trimString(address).toLowerCase();
  const atIndex = normalized.lastIndexOf('@');
  return atIndex === -1 ? '' : normalized.slice(atIndex + 1);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }
    const key = token.slice(2);
    const nextToken = argv[index + 1];
    const value = !nextToken || nextToken.startsWith('--') ? true : nextToken;
    if (value !== true) {
      index += 1;
    }
    options[key] = value;
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const rootDir = trimString(options.root);
const requestedRecipient = trimString(options.to || process.env.REMOTELAB_CF_SMOKE_TO);
const outbound = loadOutboundConfig(rootDir || undefined);
const zone = trimString(options.zone) || emailDomain(outbound.from);

let summary = buildStatusSummary({ rootDir: rootDir || undefined, zone });
summary = await enrichStatusWithLiveCloudflareState(summary);

if (summary.cloudflare.live?.error) {
  throw new Error(summary.cloudflare.live.error);
}

const destinationAddresses = Array.isArray(summary.cloudflare.live?.destinationAddresses)
  ? summary.cloudflare.live.destinationAddresses
  : [];
const verifiedDestinations = destinationAddresses
  .filter((entry) => trimString(entry?.verifiedAt))
  .sort((left, right) => trimString(left?.verifiedAt).localeCompare(trimString(right?.verifiedAt)));
const verifiedEmails = verifiedDestinations.map((entry) => entry.email);
const recipient = requestedRecipient || verifiedEmails[0] || '';

if (!recipient) {
  throw new Error('No verified Cloudflare Email Routing destination address is available. Add or verify one first.');
}

if (!verifiedEmails.includes(recipient.toLowerCase())) {
  throw new Error(`Destination address is not verified in Cloudflare Email Routing: ${recipient}`);
}

assert.equal(trimString(outbound.provider || 'cloudflare_worker'), 'cloudflare_worker');

const sender = trimString(outbound.from) || trimString(summary.mailbox.ownerAddress);
if (!sender) {
  throw new Error('Outbound sender is not configured.');
}

const stamp = new Date().toISOString();
const subject = `RemoteLab Cloudflare live smoke ${stamp}`;
const text = `RemoteLab Cloudflare outbound live smoke to ${recipient}.`;

const result = await sendOutboundEmail({
  to: recipient,
  from: sender,
  subject,
  text,
}, outbound, {
  forceCurlTransport: true,
});

console.log(JSON.stringify({
  status: 'sent',
  recipient,
  subject,
  workerBaseUrl: trimString(outbound.workerBaseUrl),
  response: result.response,
}, null, 2));
