import { access, constants as fsConstants } from 'fs/promises';
import { execFile } from 'child_process';
import { delimiter, dirname, join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const DEFAULT_SHELL = process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
const SHELL_ENV_EXPORT_B64 = 'REMOTELAB_USER_SHELL_ENV_B64';
const SHELL_ENV_START_MARKER = '__REMOTELAB_SHELL_ENV_START__';
const SHELL_ENV_END_MARKER = '__REMOTELAB_SHELL_ENV_END__';
const SHELL_ENV_PROBE_TIMEOUT_MS = 5000;
const SHELL_ENV_PROBE_MAX_BUFFER = 4 * 1024 * 1024;

const SHELL_ENV_PROBE_MODES = [
  { name: 'interactive-login', args: ['-i', '-l', '-c'] },
  { name: 'interactive', args: ['-i', '-c'] },
  { name: 'login', args: ['-l', '-c'] },
  { name: 'plain', args: ['-c'] },
];

function dedupeEntries(entries = []) {
  const seen = new Set();
  const deduped = [];
  for (const entry of entries) {
    const trimmed = String(entry || '').trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    deduped.push(trimmed);
  }
  return deduped;
}

function collectPathEntries(...values) {
  const entries = [];
  for (const value of values) {
    if (!value) continue;
    if (Array.isArray(value)) {
      entries.push(...collectPathEntries(...value));
      continue;
    }
    for (const part of String(value).split(delimiter)) {
      const trimmed = part.trim();
      if (trimmed) entries.push(trimmed);
    }
  }
  return dedupeEntries(entries);
}

function formatPath(entries = []) {
  return dedupeEntries(entries).join(delimiter);
}

function buildFallbackPathEntries(baseEnv = process.env) {
  const home = String(baseEnv?.HOME || process.env.HOME || '').trim();
  const nodeBinDir = process.execPath ? dirname(process.execPath) : '';

  return collectPathEntries(
    nodeBinDir,
    `${home}/.local/bin`,
    process.platform === 'darwin'
      ? [
          `${home}/Library/pnpm`,
          '/opt/homebrew/bin',
          '/opt/homebrew/sbin',
        ]
      : [
          '/snap/bin',
          `${home}/.nvm/versions/node/current/bin`,
          `${home}/.cargo/bin`,
          `${home}/go/bin`,
        ],
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  );
}

async function pathExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function pickShellExecutable() {
  const candidates = [
    process.env.REMOTELAB_USER_SHELL,
    process.env.SHELL,
    DEFAULT_SHELL,
    '/bin/sh',
  ];
  for (const candidate of candidates) {
    const trimmed = String(candidate || '').trim();
    if (trimmed && await pathExists(trimmed)) {
      return trimmed;
    }
  }
  return DEFAULT_SHELL;
}

function buildShellEnvDumpCommand() {
  return [
    `printf '%s\\0' '${SHELL_ENV_START_MARKER}'`,
    'env -0',
    `printf '%s\\0' '${SHELL_ENV_END_MARKER}'`,
  ].join('; ');
}

function parseEnvDump(stdout) {
  const output = typeof stdout === 'string' ? stdout : String(stdout || '');
  const startMarker = `${SHELL_ENV_START_MARKER}\u0000`;
  const endMarker = `${SHELL_ENV_END_MARKER}\u0000`;
  const startIndex = output.indexOf(startMarker);
  if (startIndex === -1) return null;
  const payloadStart = startIndex + startMarker.length;
  const endIndex = output.indexOf(endMarker, payloadStart);
  if (endIndex === -1) return null;

  const env = {};
  const payload = output.slice(payloadStart, endIndex);
  for (const record of payload.split('\u0000')) {
    if (!record) continue;
    const separatorIndex = record.indexOf('=');
    if (separatorIndex <= 0) continue;
    const key = record.slice(0, separatorIndex);
    const value = record.slice(separatorIndex + 1);
    env[key] = value;
  }
  return env;
}

async function probeShellEnv(shellPath) {
  const command = buildShellEnvDumpCommand();
  for (const mode of SHELL_ENV_PROBE_MODES) {
    try {
      const { stdout } = await execFileAsync(shellPath, [...mode.args, command], {
        encoding: 'utf8',
        timeout: SHELL_ENV_PROBE_TIMEOUT_MS,
        maxBuffer: SHELL_ENV_PROBE_MAX_BUFFER,
      });
      const env = parseEnvDump(stdout);
      if (env && Object.keys(env).length > 0) {
        return {
          shell: shellPath,
          mode: mode.name,
          env,
        };
      }
    } catch {
    }
  }
  return null;
}

function parseInjectedShellSnapshot(fallbackShell) {
  const encoded = String(process.env[SHELL_ENV_EXPORT_B64] || '').trim();
  if (!encoded) return null;
  try {
    const raw = Buffer.from(encoded, 'base64').toString('utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.env !== 'object' || !parsed.env) {
      return null;
    }
    return {
      shell: String(parsed.shell || fallbackShell).trim() || fallbackShell,
      mode: String(parsed.mode || 'injected').trim() || 'injected',
      env: { ...parsed.env },
    };
  } catch {
    return null;
  }
}

function finalizeShellSnapshot(snapshot, fallbackShell) {
  const shell = String(snapshot?.shell || fallbackShell).trim() || fallbackShell;
  const mode = String(snapshot?.mode || 'fallback').trim() || 'fallback';
  const shellEnv = snapshot?.env && typeof snapshot.env === 'object' ? { ...snapshot.env } : {};
  const fullPath = formatPath(
    collectPathEntries(
      shellEnv.PATH,
      process.env.PATH,
      buildFallbackPathEntries({ ...shellEnv, ...process.env }),
    ),
  );
  return {
    shell,
    mode,
    env: shellEnv,
    fullPath,
  };
}

const preferredShell = await pickShellExecutable();
const resolvedShellSnapshot = finalizeShellSnapshot(
  parseInjectedShellSnapshot(preferredShell)
  || await probeShellEnv(preferredShell)
  || { shell: preferredShell, mode: 'fallback', env: {} },
  preferredShell,
);

export const userShell = resolvedShellSnapshot.shell;
export const userShellMode = resolvedShellSnapshot.mode;
export const userShellEnv = Object.freeze({ ...resolvedShellSnapshot.env, PATH: resolvedShellSnapshot.fullPath });
export const fullPath = userShellEnv.PATH;

export function serializeUserShellEnvSnapshot() {
  const existing = String(process.env[SHELL_ENV_EXPORT_B64] || '').trim();
  if (existing) return existing;
  return Buffer.from(
    JSON.stringify({
      shell: userShell,
      mode: userShellMode,
      env: userShellEnv,
    }),
    'utf8',
  ).toString('base64');
}

export function buildToolProcessEnv(overrides = {}) {
  const env = {
    ...userShellEnv,
    ...process.env,
    ...overrides,
  };
  env.PATH = formatPath(
    collectPathEntries(
      overrides.PATH,
      userShellEnv.PATH,
      process.env.PATH,
      buildFallbackPathEntries(env),
    ),
  );
  return env;
}

async function isExecutableFile(path) {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveExecutableCommandPathAsync(command) {
  const trimmed = String(command || '').trim();
  if (!trimmed) return null;
  if (trimmed.includes('/')) {
    return await isExecutableFile(trimmed) ? trimmed : null;
  }
  for (const dir of collectPathEntries(fullPath)) {
    const candidate = join(dir, trimmed);
    if (await isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}
