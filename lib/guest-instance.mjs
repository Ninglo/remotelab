import { parseCloudflaredIngress } from './cloudflared-config.mjs';

export const DEFAULT_GUEST_INSTANCE_START_PORT = 7696;
export const DEFAULT_GUEST_SESSION_EXPIRY_DAYS = 30;
export const DEFAULT_GUEST_CHAT_BIND_HOST = '127.0.0.1';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeHostname(value) {
  return trimString(value).toLowerCase();
}

function serviceTargetsPort(service, port) {
  const normalizedService = trimString(service);
  if (!normalizedService) return false;
  try {
    const url = new URL(normalizedService);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    const normalizedPort = url.port || (url.protocol === 'https:' ? '443' : '80');
    return Number(normalizedPort) === Number(port);
  } catch {
    return false;
  }
}

export function parseTunnelName(content) {
  const match = String(content || '').match(/^tunnel:\s*(\S+)\s*$/m);
  return trimString(match?.[1] || '');
}

export function sanitizeGuestInstanceName(value) {
  return trimString(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function deriveDomainFromHostname(hostname) {
  const normalizedHostname = normalizeHostname(hostname);
  if (!normalizedHostname.includes('.')) return '';
  const parts = normalizedHostname.split('.').filter(Boolean);
  if (parts.length < 2) return '';
  return parts.slice(1).join('.');
}

export function selectPrimaryHostnameForPort(content, { port = 7690 } = {}) {
  const candidates = parseCloudflaredIngress(content)
    .filter((entry) => serviceTargetsPort(entry.service, port));
  if (candidates.length === 0) return '';

  const preferredCandidate = candidates.find((entry) => normalizeHostname(entry.hostname).includes('remotelab'));
  return trimString(preferredCandidate?.hostname || candidates[0]?.hostname || '');
}

export function deriveGuestHostname(content, {
  name = '',
  subdomain = '',
  domain = '',
  ownerPort = 7690,
} = {}) {
  const normalizedSubdomain = sanitizeGuestInstanceName(subdomain || name);
  if (!normalizedSubdomain) return '';

  const normalizedDomain = trimString(domain).replace(/^\.+|\.+$/g, '').toLowerCase()
    || deriveDomainFromHostname(selectPrimaryHostnameForPort(content, { port: ownerPort }));
  if (!normalizedDomain) return '';
  return `${normalizedSubdomain}.${normalizedDomain}`;
}

export function pickNextGuestPort(usedPorts = [], { startPort = DEFAULT_GUEST_INSTANCE_START_PORT } = {}) {
  const normalizedStartPort = Number.parseInt(startPort, 10);
  if (!Number.isInteger(normalizedStartPort) || normalizedStartPort < 1 || normalizedStartPort > 65535) {
    throw new Error(`Invalid start port: ${startPort}`);
  }

  const reservedPorts = new Set(
    Array.from(usedPorts || [])
      .map((port) => Number.parseInt(port, 10))
      .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535),
  );

  for (let port = normalizedStartPort; port <= 65535; port += 1) {
    if (!reservedPorts.has(port)) {
      return port;
    }
  }

  throw new Error(`No free guest-instance port available from ${normalizedStartPort}`);
}

function findIngressSectionBounds(lines) {
  const ingressIndex = lines.findIndex((line) => /^ingress:\s*$/.test(line));
  if (ingressIndex === -1) {
    return { ingressIndex: -1, sectionEndIndex: -1 };
  }

  let sectionEndIndex = lines.length;
  for (let index = ingressIndex + 1; index < lines.length; index += 1) {
    if (/^[A-Za-z0-9_-]+\s*:/.test(lines[index])) {
      sectionEndIndex = index;
      break;
    }
  }

  return { ingressIndex, sectionEndIndex };
}

function listIngressEntryRanges(lines, ingressIndex, sectionEndIndex) {
  const entryStartIndices = [];
  for (let index = ingressIndex + 1; index < sectionEndIndex; index += 1) {
    if (/^\s*-\s*(hostname|service):/.test(lines[index])) {
      entryStartIndices.push(index);
    }
  }

  return entryStartIndices.map((startIndex, entryIndex) => ({
    startIndex,
    endIndex: entryStartIndices[entryIndex + 1] || sectionEndIndex,
  }));
}

export function upsertCloudflaredIngress(content, { hostname, service }) {
  const normalizedHostname = trimString(hostname);
  const normalizedService = trimString(service);
  if (!normalizedHostname) throw new Error('hostname is required');
  if (!normalizedService) throw new Error('service is required');

  const source = String(content || '');
  const lines = source ? source.replace(/\r\n/g, '\n').split('\n') : [];
  const hadTrailingNewline = source.endsWith('\n');
  const { ingressIndex, sectionEndIndex } = findIngressSectionBounds(lines);

  if (ingressIndex === -1) {
    const prefix = lines.filter((line, index) => !(index === lines.length - 1 && line === ''));
    if (prefix.length > 0 && prefix[prefix.length - 1] !== '') {
      prefix.push('');
    }
    prefix.push('ingress:');
    prefix.push(`  - hostname: ${normalizedHostname}`);
    prefix.push(`    service: ${normalizedService}`);
    prefix.push('  - service: http_status:404');
    return `${prefix.join('\n')}\n`;
  }

  const entryRanges = listIngressEntryRanges(lines, ingressIndex, sectionEndIndex);
  const matchingEntry = entryRanges.find(({ startIndex, endIndex }) => {
    const entryLines = lines.slice(startIndex, endIndex);
    const hostnameLine = entryLines.find((line) => /^\s*-\s*hostname:\s*/.test(line));
    const entryHostname = trimString(hostnameLine?.replace(/^\s*-\s*hostname:\s*/, '') || '');
    return normalizeHostname(entryHostname) === normalizeHostname(normalizedHostname);
  });

  if (matchingEntry) {
    const { startIndex, endIndex } = matchingEntry;
    const serviceLineIndex = lines.findIndex((line, index) => index >= startIndex && index < endIndex && /^\s*service:\s*/.test(line));
    if (serviceLineIndex >= 0) {
      const indent = (lines[serviceLineIndex].match(/^(\s*)/) || ['    '])[1] || '    ';
      lines[serviceLineIndex] = `${indent}service: ${normalizedService}`;
    } else {
      lines.splice(startIndex + 1, 0, `    service: ${normalizedService}`);
    }
    return `${lines.join('\n')}${hadTrailingNewline ? '\n' : ''}`;
  }

  const fallbackEntry = entryRanges.find(({ startIndex, endIndex }) => {
    const entryLines = lines.slice(startIndex, endIndex);
    return entryLines.some((line) => /^\s*-\s*service:\s*http_status:404\s*$/.test(line));
  });
  const insertIndex = fallbackEntry?.startIndex || sectionEndIndex;
  lines.splice(insertIndex, 0, `  - hostname: ${normalizedHostname}`, `    service: ${normalizedService}`);
  return `${lines.join('\n')}${hadTrailingNewline ? '\n' : ''}`;
}

export function buildGuestBootstrapText({ name, hostname = '' } = {}) {
  const lines = [
    '# Guest Bootstrap',
    '',
    `- Instance: \`${trimString(name) || 'guest'}\``,
    '- Purpose: isolated guest RemoteLab workspace on the same machine.',
    '- Boundary: keep auth, memory, chat history, runs, and sessions inside this instance only.',
    '- Default: optimize for out-of-box use; do not assume access to the owner\'s main memory or config.',
  ];
  lines.push('');
  return lines.join('\n');
}

function xmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildLaunchAgentPlist({
  label,
  nodePath,
  chatServerPath,
  workingDirectory,
  standardOutPath,
  standardErrorPath,
  environmentVariables = {},
} = {}) {
  const normalizedLabel = trimString(label);
  const normalizedNodePath = trimString(nodePath);
  const normalizedChatServerPath = trimString(chatServerPath);
  const normalizedWorkingDirectory = trimString(workingDirectory);
  const normalizedStandardOutPath = trimString(standardOutPath);
  const normalizedStandardErrorPath = trimString(standardErrorPath);

  if (!normalizedLabel || !normalizedNodePath || !normalizedChatServerPath) {
    throw new Error('label, nodePath, and chatServerPath are required');
  }

  const envEntries = Object.entries(environmentVariables)
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '')
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  const envBlock = envEntries.map(([key, value]) => [
    '        <key>',
    xmlEscape(key),
    '</key>',
    '<string>',
    xmlEscape(value),
    '</string>',
  ].join('')).join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"',
    '  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '    <key>Label</key>',
    `    <string>${xmlEscape(normalizedLabel)}</string>`,
    '    <key>ProgramArguments</key>',
    '    <array>',
    `        <string>${xmlEscape(normalizedNodePath)}</string>`,
    `        <string>${xmlEscape(normalizedChatServerPath)}</string>`,
    '    </array>',
    '    <key>EnvironmentVariables</key>',
    '    <dict>',
    envBlock,
    '    </dict>',
    '    <key>RunAtLoad</key>',
    '    <true/>',
    '    <key>KeepAlive</key>',
    '    <true/>',
    '    <key>WorkingDirectory</key>',
    `    <string>${xmlEscape(normalizedWorkingDirectory)}</string>`,
    '    <key>StandardOutPath</key>',
    `    <string>${xmlEscape(normalizedStandardOutPath)}</string>`,
    '    <key>StandardErrorPath</key>',
    `    <string>${xmlEscape(normalizedStandardErrorPath)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}
