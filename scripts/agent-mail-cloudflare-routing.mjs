#!/usr/bin/env node

import { resolveMx } from 'dns/promises';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import net from 'net';
import { fileURLToPath } from 'url';

import {
  DEFAULT_ROOT_DIR,
  loadBridge,
  loadIdentity,
  loadOutboundConfig,
  normalizeInstanceAddressMode,
} from '../lib/agent-mailbox.mjs';
import { loadMailboxRuntimeRegistry } from '../lib/mailbox-runtime-registry.mjs';

const DEFAULT_OWNER_CONFIG_DIR = join(homedir(), '.config', 'remotelab');
const DEFAULT_GUEST_REGISTRY_FILE = join(DEFAULT_OWNER_CONFIG_DIR, 'guest-instances.json');
const DEFAULT_CLOUDFLARE_AUTH_FILE = join(DEFAULT_OWNER_CONFIG_DIR, 'cloudflare-auth.json');
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_WORKER_CONFIG_FILE = join(REPO_ROOT, 'cloudflare', 'email-worker', 'wrangler.jsonc');
const DEFAULT_CONNECT_TIMEOUT_MS = 15000;

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
    options[key] = value;
  }

  return { positional, options };
}

function optionValue(options, key, fallbackValue = undefined) {
  const value = options[key];
  return value === undefined ? fallbackValue : value;
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function dedupeStrings(values = []) {
  return [...new Set(values.map((value) => trimString(value).toLowerCase()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function safeRuleNameFragment(value) {
  return trimString(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'mailbox';
}

function printUsage(exitCode = 0) {
  const output = exitCode === 0 ? console.log : console.error;
  output(`Usage:
  node scripts/agent-mail-cloudflare-routing.mjs status [--root <dir>] [--zone <domain>] [--live] [--json]
  node scripts/agent-mail-cloudflare-routing.mjs sync [--root <dir>] [--zone <domain>] [--enable-catch-all] [--json]
  node scripts/agent-mail-cloudflare-routing.mjs probe --address <email> [--mx-host <host>] [--json]

Examples:
  node scripts/agent-mail-cloudflare-routing.mjs status --json
  node scripts/agent-mail-cloudflare-routing.mjs status --live --json
  node scripts/agent-mail-cloudflare-routing.mjs sync --json
  node scripts/agent-mail-cloudflare-routing.mjs probe --address rowan@jiujianian.dev
  node scripts/agent-mail-cloudflare-routing.mjs probe --address trial6@jiujianian.dev --json

Notes:
  - This helper summarizes and can sync the desired Cloudflare Email Routing shape for RemoteLab guest-instance mailboxes.
  - It supports either \`CLOUDFLARE_API_TOKEN\` or \`CLOUDFLARE_GLOBAL_API_KEY\`/\`CLOUDFLARE_API_KEY\` plus \`CLOUDFLARE_EMAIL\`.
  - Local Cloudflare auth can also live in \`${DEFAULT_CLOUDFLARE_AUTH_FILE}\`.
  - The OAuth token from \`wrangler login\` is not enough for \`/email/routing/*\` endpoints.`);
  process.exit(exitCode);
}

function readJson(filePath, fallbackValue) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallbackValue;
  }
}

function loadGuestRegistry(registryFile = DEFAULT_GUEST_REGISTRY_FILE) {
  return loadMailboxRuntimeRegistry({ registryFile })
    .map((record) => ({
      name: trimString(record?.name),
      hostname: trimString(record?.hostname),
      publicBaseUrl: trimString(record?.publicBaseUrl),
      localBaseUrl: trimString(record?.localBaseUrl),
      mailboxAddress: trimString(record?.mailboxAddress),
      mailboxAliases: Array.isArray(record?.mailboxAliases) ? record.mailboxAliases : [],
      mailboxNames: Array.isArray(record?.mailboxNames) ? record.mailboxNames : [trimString(record?.name)],
    }))
    .filter((record) => record.name);
}

function loadWorkerConfig(workerConfigFile = DEFAULT_WORKER_CONFIG_FILE) {
  return readJson(workerConfigFile, null);
}

function summarizeSendEmailBinding(workerConfig = {}) {
  const bindings = Array.isArray(workerConfig?.send_email)
    ? workerConfig.send_email.filter((entry) => entry && typeof entry === 'object')
    : [];
  const binding = bindings.find((entry) => trimString(entry?.name) === 'EMAIL') || bindings[0] || null;
  const bindingName = trimString(binding?.name);
  const destinationAddress = trimString(binding?.destination_address).toLowerCase();
  const allowedDestinationAddresses = dedupeStrings(Array.isArray(binding?.allowed_destination_addresses) ? binding.allowed_destination_addresses : []);
  const allowedSenderAddresses = dedupeStrings(Array.isArray(binding?.allowed_sender_addresses) ? binding.allowed_sender_addresses : []);

  let recipientMode = 'unconfigured';
  let recipientRestrictions = [];
  if (binding) {
    if (destinationAddress) {
      recipientMode = 'single_address';
      recipientRestrictions = [destinationAddress];
    } else if (allowedDestinationAddresses.length) {
      recipientMode = 'allowlist';
      recipientRestrictions = allowedDestinationAddresses;
    } else {
      recipientMode = 'unrestricted';
    }
  }

  return {
    configured: Boolean(binding),
    bindingName,
    availableBindingNames: bindings.map((entry) => trimString(entry?.name)).filter(Boolean),
    recipientMode,
    recipientRestrictions,
    recipientRestricted: Boolean(recipientRestrictions.length),
    senderMode: binding ? (allowedSenderAddresses.length ? 'allowlist' : 'unrestricted') : 'unconfigured',
    senderRestrictions: allowedSenderAddresses,
    senderRestricted: Boolean(allowedSenderAddresses.length),
  };
}

function loadCloudflareAuth(authFile = DEFAULT_CLOUDFLARE_AUTH_FILE) {
  const fileConfig = readJson(authFile, null) || {};
  const apiToken = trimString(process.env.CLOUDFLARE_API_TOKEN || fileConfig.apiToken || fileConfig.token);
  const email = trimString(process.env.CLOUDFLARE_EMAIL || fileConfig.email);
  const globalApiKey = trimString(
    process.env.CLOUDFLARE_GLOBAL_API_KEY
      || process.env.CLOUDFLARE_API_KEY
      || fileConfig.globalApiKey
      || fileConfig.apiKey,
  );
  const authSource = apiToken
    ? 'env_or_file_token'
    : (email && globalApiKey ? 'env_or_file_global_key' : 'missing');
  const hasFileAuth = Boolean(
    trimString(fileConfig.apiToken || fileConfig.token)
      || trimString(fileConfig.globalApiKey || fileConfig.apiKey),
  );

  return {
    apiToken,
    email,
    globalApiKey,
    authFile,
    authSource,
    configured: Boolean(apiToken || (email && globalApiKey)),
    mode: apiToken ? 'api_token' : (email && globalApiKey ? 'global_api_key' : 'missing'),
    usingAuthFile: hasFileAuth,
  };
}

function summarizeCloudflareAuthMode(auth) {
  if (!auth || auth.mode === 'missing') {
    return 'missing';
  }
  return auth.mode === 'api_token' ? 'api_token' : 'global_api_key';
}

function buildGuestMailboxAddress(name, identity) {
  const normalizedName = trimString(name).toLowerCase();
  const localPart = trimString(identity?.localPart).toLowerCase();
  const domain = trimString(identity?.domain).toLowerCase();
  if (!normalizedName || !localPart || !domain) {
    return '';
  }

  const instanceAddressMode = normalizeInstanceAddressMode(identity?.instanceAddressMode);
  if (instanceAddressMode === 'local_part') {
    return `${normalizedName}@${domain}`;
  }
  return `${localPart}+${normalizedName}@${domain}`;
}

function buildDesiredCloudflarePlan({
  zone = '',
  workerName = '',
  ownerAddress = '',
  localPart = '',
  desiredAddresses = [],
  instanceAddressMode = 'plus',
} = {}) {
  const normalizedMode = normalizeInstanceAddressMode(instanceAddressMode);
  const normalizedOwnerAddress = trimString(ownerAddress).toLowerCase();
  const normalizedZone = trimString(zone).toLowerCase();
  const normalizedLocalPart = trimString(localPart).toLowerCase();
  const dedupedAddresses = dedupeStrings(desiredAddresses);
  const requiredLiteralWorkerAddresses = normalizedMode === 'local_part'
    ? dedupedAddresses
    : dedupeStrings([normalizedOwnerAddress]);
  const requireSubaddressing = normalizedMode === 'plus' && Boolean(normalizedOwnerAddress);
  const desiredRouteModel = normalizedMode === 'local_part'
    ? 'literal_worker_rules_per_address'
    : 'owner_literal_rule_plus_subaddressing';
  const optionalCatchAllWorkerRoute = Boolean(workerName);
  const manualSteps = [];

  if (normalizedZone && workerName) {
    manualSteps.push(`Cloudflare Dashboard -> ${normalizedZone} -> Email -> Email Routing -> Settings -> Email Workers -> select ${workerName}.`);
  }
  if (desiredRouteModel === 'literal_worker_rules_per_address') {
    manualSteps.push(`Ensure a literal Email Routing rule sends each owner/guest address to ${workerName || 'the mailbox worker'}.`);
    manualSteps.push('Catch-all worker routes are optional for typo/privacy handling, but they do not replace literal direct-address routes for guest instances.');
  } else {
    manualSteps.push(`Ensure a literal Email Routing rule exists for ${normalizedOwnerAddress || 'the owner mailbox'} and points to ${workerName || 'the mailbox worker'}.`);
    manualSteps.push('Enable Email Routing subaddressing so owner+instance aliases are accepted at SMTP time.');
    manualSteps.push('Catch-all worker routes are optional for typo/privacy handling, but they do not replace subaddressing.');
  }
  manualSteps.push('After any route or settings change, run live probes for the owner mailbox and one guest mailbox before telling users the address is ready.');

  return {
    desiredRouteModel,
    requiredLiteralWorkerAddresses,
    requireSubaddressing,
    optionalCatchAllWorkerRoute,
    exampleOwnerPlusAddress: normalizedLocalPart && normalizedZone ? `${normalizedLocalPart}+trial6@${normalizedZone}` : '',
    exampleGuestDirectAddress: normalizedZone ? `trial6@${normalizedZone}` : '',
    manualSteps,
  };
}

function buildStatusSummary({
  rootDir = DEFAULT_ROOT_DIR,
  zone = '',
  authFile = DEFAULT_CLOUDFLARE_AUTH_FILE,
} = {}) {
  const identity = loadIdentity(rootDir);
  const bridge = loadBridge(rootDir);
  const outbound = loadOutboundConfig(rootDir);
  const workerConfig = loadWorkerConfig();
  const outboundBinding = summarizeSendEmailBinding(workerConfig);
  const auth = loadCloudflareAuth(authFile);
  const guestInstances = loadGuestRegistry().map((record) => {
    const mailboxAddresses = dedupeStrings([
      trimString(record.mailboxAddress),
      ...(Array.isArray(record.mailboxNames) ? record.mailboxNames : [record.name]).map((mailboxName) => buildGuestMailboxAddress(mailboxName, identity)),
    ]);
    return {
      ...record,
      mailboxAddress: mailboxAddresses[0] || '',
      mailboxAddresses,
    };
  });
  const domain = trimString(zone) || trimString(identity?.domain);
  const workerName = trimString(workerConfig?.name);
  const workerUrl = trimString(outbound?.workerBaseUrl);
  const publicWebhook = trimString(bridge?.cloudflareWebhook) || trimString(bridge?.publicWebhook);
  const instanceAddressMode = normalizeInstanceAddressMode(identity?.instanceAddressMode);

  const desiredAddresses = [
    trimString(identity?.address),
    ...guestInstances.flatMap((record) => record.mailboxAddresses || []),
  ].filter(Boolean);
  const desiredPlan = buildDesiredCloudflarePlan({
    zone: domain,
    workerName,
    ownerAddress: trimString(identity?.address),
    localPart: trimString(identity?.localPart),
    desiredAddresses,
    instanceAddressMode,
  });

  return {
    zone: domain,
    mailbox: {
      rootDir,
      ownerAddress: trimString(identity?.address),
      localPart: trimString(identity?.localPart),
      domain: trimString(identity?.domain),
      instanceAddressMode,
      exampleOwnerPlusAddress: desiredPlan.exampleOwnerPlusAddress,
      exampleGuestDirectAddress: desiredPlan.exampleGuestDirectAddress,
    },
    cloudflare: {
      workerName,
      workerUrl,
      publicWebhook,
      outboundBinding,
      outboundPlatformRecipientMode: outboundBinding.configured ? 'verified_destination_addresses_only' : 'unconfigured',
      outboundPlatformRecipientNote: outboundBinding.configured
        ? 'Cloudflare send_email can only deliver to Email Routing destination addresses verified on this account.'
        : '',
      authMode: summarizeCloudflareAuthMode(auth),
      authConfigured: auth.configured,
      authFile: auth.usingAuthFile ? authFile : '',
      desiredRouteModel: desiredPlan.desiredRouteModel,
      requiredLiteralWorkerAddresses: desiredPlan.requiredLiteralWorkerAddresses,
      requireSubaddressing: desiredPlan.requireSubaddressing,
      optionalCatchAllWorkerRoute: desiredPlan.optionalCatchAllWorkerRoute,
      apiAuthNote: 'Use CLOUDFLARE_API_TOKEN or CLOUDFLARE_GLOBAL_API_KEY/CLOUDFLARE_API_KEY plus CLOUDFLARE_EMAIL. The OAuth token from wrangler login is not sufficient.',
    },
    guestInstances,
    desiredAcceptedAddresses: desiredAddresses,
    manualSteps: desiredPlan.manualSteps,
    validationCommands: desiredAddresses.slice(0, 3).map((address) => `node scripts/agent-mail-cloudflare-routing.mjs probe --address ${address}`),
  };
}

function printStatusSummary(summary, asJson = false) {
  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`Mailbox: ${summary.mailbox.ownerAddress || 'not initialized'}`);
  console.log(`Address mode: ${summary.mailbox.instanceAddressMode}`);
  if (summary.cloudflare.workerName) {
    console.log(`Worker: ${summary.cloudflare.workerName}`);
  }
  if (summary.cloudflare.workerUrl) {
    console.log(`Worker URL: ${summary.cloudflare.workerUrl}`);
  }
  if (summary.cloudflare.publicWebhook) {
    console.log(`Bridge webhook: ${summary.cloudflare.publicWebhook}`);
  }
  if (summary.cloudflare.outboundBinding?.configured) {
    const binding = summary.cloudflare.outboundBinding;
    const recipientsLabel = binding.recipientMode === 'unrestricted'
      ? 'unrestricted'
      : binding.recipientRestrictions.join(', ');
    console.log(`Outbound binding recipients: ${recipientsLabel}`);
    if (binding.senderRestricted) {
      console.log(`Outbound binding senders: ${binding.senderRestrictions.join(', ')}`);
    }
    console.log(`Outbound platform rule: ${summary.cloudflare.outboundPlatformRecipientNote}`);
  }
  console.log(`Desired route model: ${summary.cloudflare.desiredRouteModel}`);
  console.log(`Cloudflare auth: ${summary.cloudflare.authMode}`);
  if (summary.cloudflare.authFile) {
    console.log(`Cloudflare auth file: ${summary.cloudflare.authFile}`);
  }
  console.log(`Cloudflare API note: ${summary.cloudflare.apiAuthNote}`);

  if (summary.cloudflare.requiredLiteralWorkerAddresses.length) {
    console.log(`Literal worker addresses: ${summary.cloudflare.requiredLiteralWorkerAddresses.length}`);
  }
  if (summary.cloudflare.requireSubaddressing) {
    console.log('Subaddressing required: yes');
  }

  if (summary.cloudflare.live) {
    if (summary.cloudflare.live.error) {
      console.log(`Live Cloudflare: ${summary.cloudflare.live.error}`);
    } else {
      console.log(`Live Cloudflare: status=${summary.cloudflare.live.settings.status || 'unknown'}, synced=${summary.cloudflare.live.settings.synced ? 'yes' : 'no'}, subaddressing=${summary.cloudflare.live.settings.supportSubaddress ? 'on' : 'off'}`);
      if (summary.cloudflare.live.destinationAddresses?.length) {
        console.log('\nDestination addresses:');
        for (const address of summary.cloudflare.live.destinationAddresses) {
          const status = trimString(address?.status) || (trimString(address?.verifiedAt) ? 'verified' : 'unverified');
          console.log(`- ${address.email}: ${status}`);
        }
      }
      if (summary.cloudflare.live.missingLiteralWorkerAddresses.length) {
        console.log('\nMissing literal worker routes:');
        for (const address of summary.cloudflare.live.missingLiteralWorkerAddresses) {
          console.log(`- ${address}`);
        }
      }
    }
  }

  if (summary.guestInstances.length) {
    console.log('\nGuest instances:');
    for (const record of summary.guestInstances) {
      console.log(`- ${record.name}: ${(record.mailboxAddresses || [record.mailboxAddress]).filter(Boolean).join(', ')}`);
    }
  }

  console.log('\nManual steps:');
  for (const step of summary.manualSteps) {
    console.log(`- ${step}`);
  }

  console.log('\nValidation commands:');
  for (const command of summary.validationCommands) {
    console.log(`- ${command}`);
  }
}

function cloudflareAuthErrorMessage() {
  return `Cloudflare Email Routing auth missing. Set CLOUDFLARE_API_TOKEN, or set CLOUDFLARE_GLOBAL_API_KEY/CLOUDFLARE_API_KEY plus CLOUDFLARE_EMAIL, or write ${DEFAULT_CLOUDFLARE_AUTH_FILE}.`;
}

function buildCloudflareHeaders(auth) {
  if (auth.mode === 'api_token') {
    return {
      Authorization: `Bearer ${auth.apiToken}`,
      'Content-Type': 'application/json',
    };
  }
  if (auth.mode === 'global_api_key') {
    return {
      'X-Auth-Email': auth.email,
      'X-Auth-Key': auth.globalApiKey,
      'Content-Type': 'application/json',
    };
  }
  throw new Error(cloudflareAuthErrorMessage());
}

async function cloudflareRequest(auth, { method = 'GET', path, body = undefined } = {}) {
  if (!auth?.configured) {
    throw new Error(cloudflareAuthErrorMessage());
  }

  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: buildCloudflareHeaders(auth),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok || payload?.success === false) {
    const details = Array.isArray(payload?.errors) && payload.errors.length
      ? payload.errors.map((entry) => `${entry.code || 'error'}:${entry.message || 'unknown'}`).join(', ')
      : (text || response.statusText || 'Unknown Cloudflare API error');
    throw new Error(`Cloudflare API ${method} ${path} failed: ${details}`);
  }

  return payload?.result;
}

async function lookupZone(auth, zone) {
  const zoneName = trimString(zone).toLowerCase();
  if (!zoneName) {
    throw new Error('A mailbox domain is required');
  }
  const result = await cloudflareRequest(auth, {
    path: `/zones?name=${encodeURIComponent(zoneName)}`,
  });
  const zoneRecord = Array.isArray(result) ? result[0] : null;
  if (!zoneRecord?.id) {
    throw new Error(`Cloudflare zone not found: ${zoneName}`);
  }
  return {
    id: trimString(zoneRecord.id),
    name: trimString(zoneRecord.name) || zoneName,
    accountId: trimString(zoneRecord?.account?.id),
  };
}

async function fetchDestinationAddresses(auth, accountId) {
  const normalizedAccountId = trimString(accountId);
  if (!normalizedAccountId) {
    return [];
  }
  const result = await cloudflareRequest(auth, {
    path: `/accounts/${normalizedAccountId}/email/routing/addresses`,
  });
  const addresses = Array.isArray(result) ? result : [];
  return addresses
    .map((record) => ({
      id: trimString(record?.id),
      email: trimString(record?.email).toLowerCase(),
      status: trimString(record?.status) || (trimString(record?.verified) ? 'verified' : 'unverified'),
      verifiedAt: trimString(record?.verified),
      createdAt: trimString(record?.created),
      modifiedAt: trimString(record?.modified),
    }))
    .filter((record) => record.email)
    .sort((left, right) => left.email.localeCompare(right.email));
}

function literalRuleAddress(rule) {
  if (!rule || typeof rule !== 'object' || !Array.isArray(rule.matchers)) {
    return '';
  }
  for (const matcher of rule.matchers) {
    if (trimString(matcher?.type) === 'literal' && trimString(matcher?.field || 'to') === 'to') {
      return trimString(matcher?.value).toLowerCase();
    }
  }
  return '';
}

function ruleTargetsWorker(rule, workerName) {
  const normalizedWorkerName = trimString(workerName);
  if (!normalizedWorkerName || !Array.isArray(rule?.actions)) {
    return false;
  }
  return rule.actions.some((action) => trimString(action?.type) === 'worker'
    && Array.isArray(action?.value)
    && action.value.map((entry) => trimString(entry)).includes(normalizedWorkerName));
}

function findLiteralRule(rules = [], address = '') {
  const normalizedAddress = trimString(address).toLowerCase();
  return rules.find((rule) => literalRuleAddress(rule) === normalizedAddress) || null;
}

function summarizeRule(rule) {
  if (!rule || typeof rule !== 'object') {
    return null;
  }
  return {
    id: trimString(rule.id),
    name: trimString(rule.name),
    enabled: rule.enabled !== false,
    priority: Number.isFinite(rule.priority) ? rule.priority : null,
    actions: Array.isArray(rule.actions) ? rule.actions : [],
    matchers: Array.isArray(rule.matchers) ? rule.matchers : [],
  };
}

function stripRawLiveState(value) {
  if (!value || typeof value !== 'object') {
    return value;
  }
  const { rawRules, rawCatchAllRule, ...rest } = value;
  return rest;
}

async function fetchLiveCloudflareState({ zone = '', auth, desiredPlan }) {
  const normalizedZone = trimString(zone).toLowerCase();
  if (!normalizedZone) {
    return { error: 'Mailbox domain not initialized.' };
  }
  if (!auth?.configured) {
    return { error: cloudflareAuthErrorMessage() };
  }

  const zoneRecord = await lookupZone(auth, normalizedZone);
  const destinationAddresses = await fetchDestinationAddresses(auth, zoneRecord.accountId);
  const settings = await cloudflareRequest(auth, {
    path: `/zones/${zoneRecord.id}/email/routing`,
  });
  const rules = await cloudflareRequest(auth, {
    path: `/zones/${zoneRecord.id}/email/routing/rules?per_page=100`,
  });
  let catchAllRule = null;
  try {
    catchAllRule = await cloudflareRequest(auth, {
      path: `/zones/${zoneRecord.id}/email/routing/rules/catch_all`,
    });
  } catch {
    catchAllRule = null;
  }

  const ruleList = Array.isArray(rules) ? rules : [];
  const literalWorkerAddresses = dedupeStrings(
    ruleList
      .filter((rule) => ruleTargetsWorker(rule, desiredPlan?.requiredLiteralWorkerAddresses?.length ? desiredPlan.workerName : ''))
      .map((rule) => literalRuleAddress(rule)),
  );

  const desiredLiteralWorkerAddresses = Array.isArray(desiredPlan?.requiredLiteralWorkerAddresses)
    ? desiredPlan.requiredLiteralWorkerAddresses
    : [];

  return {
    accountId: zoneRecord.accountId,
    zoneId: zoneRecord.id,
    zoneName: zoneRecord.name,
    destinationAddresses,
    settings: {
      enabled: settings?.enabled === true,
      status: trimString(settings?.status),
      skipWizard: settings?.skip_wizard === true,
      supportSubaddress: settings?.support_subaddress === true,
      synced: settings?.synced === true,
      adminLocked: settings?.admin_locked === true,
    },
    literalWorkerAddresses,
    missingLiteralWorkerAddresses: desiredLiteralWorkerAddresses.filter((address) => !literalWorkerAddresses.includes(trimString(address).toLowerCase())),
    catchAllRule: summarizeRule(catchAllRule),
    rules: ruleList.map((rule) => summarizeRule(rule)).filter(Boolean),
    rawRules: ruleList,
    rawCatchAllRule: catchAllRule,
  };
}

async function enrichStatusWithLiveCloudflareState(summary, { authFile = DEFAULT_CLOUDFLARE_AUTH_FILE } = {}) {
  const auth = loadCloudflareAuth(authFile);
  const desiredPlan = {
    workerName: summary.cloudflare.workerName,
    requiredLiteralWorkerAddresses: summary.cloudflare.requiredLiteralWorkerAddresses,
  };
  try {
    const live = await fetchLiveCloudflareState({
      zone: summary.zone,
      auth,
      desiredPlan,
    });
    return {
      ...summary,
      cloudflare: {
        ...summary.cloudflare,
        live,
      },
    };
  } catch (error) {
    return {
      ...summary,
      cloudflare: {
        ...summary.cloudflare,
        live: {
          error: error instanceof Error ? error.message : String(error),
        },
      },
    };
  }
}

async function updateZoneSettings(auth, zoneId, body) {
  return cloudflareRequest(auth, {
    method: 'PATCH',
    path: `/zones/${zoneId}/email/routing`,
    body,
  });
}

function buildLiteralWorkerRulePayload(address, workerName, existingRule = null) {
  return {
    enabled: true,
    name: trimString(existingRule?.name) || `remotelab-mailbox-${safeRuleNameFragment(address)}`,
    priority: Number.isFinite(existingRule?.priority) ? existingRule.priority : 0,
    matchers: [{ type: 'literal', field: 'to', value: address }],
    actions: [{ type: 'worker', value: [workerName] }],
  };
}

async function ensureLiteralWorkerRule({ auth, zoneId, address, workerName, rules = [] }) {
  const normalizedAddress = trimString(address).toLowerCase();
  const existingRule = findLiteralRule(rules, normalizedAddress);

  if (existingRule && existingRule.enabled !== false && ruleTargetsWorker(existingRule, workerName)) {
    return {
      action: 'unchanged',
      address: normalizedAddress,
      ruleId: trimString(existingRule.id),
    };
  }

  const payload = buildLiteralWorkerRulePayload(normalizedAddress, workerName, existingRule);
  const path = trimString(existingRule?.id)
    ? `/zones/${zoneId}/email/routing/rules/${existingRule.id}`
    : `/zones/${zoneId}/email/routing/rules`;
  const method = trimString(existingRule?.id) ? 'PUT' : 'POST';

  await cloudflareRequest(auth, {
    method,
    path,
    body: payload,
  });

  const refreshedRules = await cloudflareRequest(auth, {
    path: `/zones/${zoneId}/email/routing/rules?per_page=100`,
  });
  const confirmedRule = findLiteralRule(Array.isArray(refreshedRules) ? refreshedRules : [], normalizedAddress);

  return {
    action: existingRule ? 'updated' : 'created',
    address: normalizedAddress,
    ruleId: trimString(confirmedRule?.id || existingRule?.id),
  };
}

async function ensureCatchAllWorkerRule({ auth, zoneId, workerName, currentRule = null }) {
  const rule = currentRule || await cloudflareRequest(auth, {
    path: `/zones/${zoneId}/email/routing/rules/catch_all`,
  });

  if (rule?.enabled !== false && ruleTargetsWorker(rule, workerName) && Array.isArray(rule?.matchers) && rule.matchers.some((matcher) => trimString(matcher?.type) === 'all')) {
    return { action: 'unchanged' };
  }

  await cloudflareRequest(auth, {
    method: 'PUT',
    path: `/zones/${zoneId}/email/routing/rules/catch_all`,
    body: {
      enabled: true,
      name: trimString(rule?.name) || 'remotelab-catch-all-worker',
      matchers: [{ type: 'all' }],
      actions: [{ type: 'worker', value: [workerName] }],
    },
  });

  return { action: 'updated' };
}

async function syncCloudflareRouting({
  rootDir = DEFAULT_ROOT_DIR,
  zone = '',
  authFile = DEFAULT_CLOUDFLARE_AUTH_FILE,
  enableCatchAll = false,
} = {}) {
  const summary = buildStatusSummary({ rootDir, zone, authFile });
  const auth = loadCloudflareAuth(authFile);
  if (!auth.configured) {
    throw new Error(cloudflareAuthErrorMessage());
  }
  if (!summary.zone) {
    throw new Error('Mailbox domain is not initialized');
  }
  if (!summary.cloudflare.workerName) {
    throw new Error(`Worker config not found at ${DEFAULT_WORKER_CONFIG_FILE}`);
  }

  const desiredPlan = {
    workerName: summary.cloudflare.workerName,
    requiredLiteralWorkerAddresses: summary.cloudflare.requiredLiteralWorkerAddresses,
    requireSubaddressing: summary.cloudflare.requireSubaddressing,
  };
  const liveBefore = await fetchLiveCloudflareState({
    zone: summary.zone,
    auth,
    desiredPlan,
  });
  if (liveBefore.error) {
    throw new Error(liveBefore.error);
  }

  const operations = [];

  if (summary.cloudflare.requireSubaddressing && !liveBefore.settings.supportSubaddress) {
    await updateZoneSettings(auth, liveBefore.zoneId, {
      enabled: true,
      skip_wizard: true,
      support_subaddress: true,
    });
    operations.push({
      type: 'settings',
      action: 'updated',
      setting: 'support_subaddress',
      value: true,
    });
  }

  let refreshedRules = Array.isArray(liveBefore.rawRules) ? liveBefore.rawRules : [];
  for (const address of summary.cloudflare.requiredLiteralWorkerAddresses) {
    const result = await ensureLiteralWorkerRule({
      auth,
      zoneId: liveBefore.zoneId,
      address,
      workerName: summary.cloudflare.workerName,
      rules: refreshedRules,
    });
    if (result.action !== 'unchanged') {
      operations.push({ type: 'literal_worker_rule', ...result });
      refreshedRules = await cloudflareRequest(auth, {
        path: `/zones/${liveBefore.zoneId}/email/routing/rules?per_page=100`,
      });
    }
  }

  if (enableCatchAll) {
    const result = await ensureCatchAllWorkerRule({
      auth,
      zoneId: liveBefore.zoneId,
      workerName: summary.cloudflare.workerName,
      currentRule: liveBefore.rawCatchAllRule,
    });
    if (result.action !== 'unchanged') {
      operations.push({ type: 'catch_all_rule', ...result });
    }
  }

  const liveAfter = await fetchLiveCloudflareState({
    zone: summary.zone,
    auth,
    desiredPlan,
  });

  return {
    zone: summary.zone,
    zoneId: liveBefore.zoneId,
    authMode: summarizeCloudflareAuthMode(auth),
    desiredRouteModel: summary.cloudflare.desiredRouteModel,
    operations,
    before: stripRawLiveState(liveBefore),
    after: stripRawLiveState(liveAfter),
  };
}

function parseSmtpCode(line) {
  const match = String(line).match(/^(\d{3})([\s-])/);
  if (!match) {
    return { code: 0, finished: true };
  }
  return {
    code: Number.parseInt(match[1], 10),
    finished: match[2] === ' ',
  };
}

function waitForResponse(socket, bufferState) {
  return new Promise((resolve, reject) => {
    const tryConsume = () => {
      while (true) {
        const newlineIndex = bufferState.value.indexOf('\n');
        if (newlineIndex === -1) {
          return false;
        }
        const rawLine = bufferState.value.slice(0, newlineIndex + 1);
        bufferState.value = bufferState.value.slice(newlineIndex + 1);
        const line = rawLine.replace(/\r?\n$/, '');
        bufferState.lines.push(line);
        const parsed = parseSmtpCode(line);
        if (parsed.finished) {
          cleanup();
          resolve({ code: parsed.code, lines: [...bufferState.lines] });
          return true;
        }
      }
    };

    const onData = (chunk) => {
      bufferState.value += chunk.toString('utf8');
      tryConsume();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onTimeout = () => {
      cleanup();
      reject(new Error('SMTP response timed out'));
    };
    const onClose = () => {
      cleanup();
      reject(new Error('SMTP connection closed unexpectedly'));
    };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('timeout', onTimeout);
      socket.off('close', onClose);
    };

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('timeout', onTimeout);
    socket.on('close', onClose);
    tryConsume();
  });
}

async function readSmtpResponse(socket, transcript) {
  const bufferState = { value: '', lines: [] };
  const response = await waitForResponse(socket, bufferState);
  for (const line of response.lines) {
    transcript.push({ direction: 'recv', line });
  }
  return response;
}

async function sendSmtpCommand(socket, command, transcript) {
  transcript.push({ direction: 'send', line: command });
  socket.write(`${command}\r\n`);
}

async function smtpProbe(address, mxHost) {
  const targetAddress = trimString(address).toLowerCase();
  const atIndex = targetAddress.lastIndexOf('@');
  if (atIndex === -1) {
    throw new Error(`Invalid email address: ${address}`);
  }

  const domain = targetAddress.slice(atIndex + 1);
  const mxRecords = mxHost
    ? [{ exchange: trimString(mxHost), priority: 0 }]
    : (await resolveMx(domain)).sort((left, right) => left.priority - right.priority);
  const transcript = [];
  let lastError = null;

  for (const record of mxRecords) {
    const socket = new net.Socket();
    socket.setTimeout(DEFAULT_CONNECT_TIMEOUT_MS);
    try {
      await new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.connect(25, record.exchange, resolve);
      });

      const banner = await readSmtpResponse(socket, transcript);
      if (banner.code !== 220) {
        throw new Error(`Unexpected SMTP banner from ${record.exchange}: ${banner.lines.join(' | ')}`);
      }

      await sendSmtpCommand(socket, 'EHLO remotelab.local', transcript);
      await readSmtpResponse(socket, transcript);
      await sendSmtpCommand(socket, `MAIL FROM:<smtp-probe@${domain}>`, transcript);
      await readSmtpResponse(socket, transcript);
      await sendSmtpCommand(socket, `RCPT TO:<${targetAddress}>`, transcript);
      const rcpt = await readSmtpResponse(socket, transcript);
      await sendSmtpCommand(socket, 'QUIT', transcript);
      try {
        await readSmtpResponse(socket, transcript);
      } catch {
      }
      socket.end();

      return {
        address: targetAddress,
        mxHost: record.exchange,
        accepted: rcpt.code === 250 || rcpt.code === 251,
        code: rcpt.code,
        response: rcpt.lines.join(' | '),
        transcript,
      };
    } catch (error) {
      lastError = error;
      transcript.push({ direction: 'error', line: `${record.exchange}: ${error instanceof Error ? error.message : String(error)}` });
      socket.destroy();
    }
  }

  if (lastError) {
    return {
      address: targetAddress,
      mxHost: mxRecords[0]?.exchange || '',
      accepted: false,
      code: 0,
      response: lastError instanceof Error ? lastError.message : String(lastError),
      transcript,
    };
  }

  return {
    address: targetAddress,
    mxHost: '',
    accepted: false,
    code: 0,
    response: 'No MX hosts resolved',
    transcript,
  };
}

function printProbeResult(result, asJson = false) {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Address: ${result.address}`);
  console.log(`MX host: ${result.mxHost || 'n/a'}`);
  console.log(`Accepted: ${result.accepted ? 'yes' : 'no'}`);
  console.log(`Response: ${result.response}`);
}

function printSyncResult(result, asJson = false) {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Zone: ${result.zone}`);
  console.log(`Auth: ${result.authMode}`);
  console.log(`Desired route model: ${result.desiredRouteModel}`);
  if (!result.operations.length) {
    console.log('Changes: none');
  } else {
    console.log('Changes:');
    for (const operation of result.operations) {
      if (operation.type === 'settings') {
        console.log(`- updated ${operation.setting}=${operation.value}`);
      } else if (operation.type === 'literal_worker_rule') {
        console.log(`- ${operation.action} literal worker rule for ${operation.address}`);
      } else if (operation.type === 'catch_all_rule') {
        console.log(`- ${operation.action} catch-all worker rule`);
      }
    }
  }
  if (result.after?.missingLiteralWorkerAddresses?.length) {
    console.log('Still missing literal worker routes:');
    for (const address of result.after.missingLiteralWorkerAddresses) {
      console.log(`- ${address}`);
    }
  }
  if (result.after?.settings) {
    console.log(`Live after: status=${result.after.settings.status || 'unknown'}, synced=${result.after.settings.synced ? 'yes' : 'no'}, subaddressing=${result.after.settings.supportSubaddress ? 'on' : 'off'}`);
  }
}

async function main(argv = process.argv.slice(2)) {
  const { positional, options } = parseArgs(argv);
  const command = positional[0];
  if (!command || command === '--help' || command === 'help') {
    printUsage(0);
  }

  if (command === 'status') {
    let summary = buildStatusSummary({
      rootDir: optionValue(options, 'root', DEFAULT_ROOT_DIR),
      zone: optionValue(options, 'zone', ''),
      authFile: optionValue(options, 'auth-file', DEFAULT_CLOUDFLARE_AUTH_FILE),
    });
    if (optionValue(options, 'live', false) === true) {
      summary = await enrichStatusWithLiveCloudflareState(summary, {
        authFile: optionValue(options, 'auth-file', DEFAULT_CLOUDFLARE_AUTH_FILE),
      });
    }
    printStatusSummary(summary, optionValue(options, 'json', false) === true);
    return;
  }

  if (command === 'sync') {
    const result = await syncCloudflareRouting({
      rootDir: optionValue(options, 'root', DEFAULT_ROOT_DIR),
      zone: optionValue(options, 'zone', ''),
      authFile: optionValue(options, 'auth-file', DEFAULT_CLOUDFLARE_AUTH_FILE),
      enableCatchAll: optionValue(options, 'enable-catch-all', false) === true,
    });
    printSyncResult(result, optionValue(options, 'json', false) === true);
    return;
  }

  if (command === 'probe') {
    const address = optionValue(options, 'address', positional[1] || '');
    if (!address) {
      throw new Error('probe requires --address <email>');
    }

    const result = await smtpProbe(address, optionValue(options, 'mx-host', ''));
    printProbeResult(result, optionValue(options, 'json', false) === true);
    process.exit(result.accepted ? 0 : 1);
  }

  throw new Error(`Unknown command: ${command}`);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export {
  buildDesiredCloudflarePlan,
  buildGuestMailboxAddress,
  buildStatusSummary,
  enrichStatusWithLiveCloudflareState,
  findLiteralRule,
  literalRuleAddress,
  loadCloudflareAuth,
  ruleTargetsWorker,
  summarizeSendEmailBinding,
  syncCloudflareRouting,
};
