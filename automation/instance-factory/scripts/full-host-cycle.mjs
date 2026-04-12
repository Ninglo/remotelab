#!/usr/bin/env node
import { execFile as execFileCallback } from 'child_process';
import { mkdtemp, readFile, writeFile } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { basename, join, resolve } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFileCallback);
const PROJECT_ROOT = '/opt/remotelab';
const DEFAULT_SSH_KEY = join(homedir(), '.ssh', 'id_ed25519');

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function removeJsonComments(source) {
  let result = '';
  let inString = false;
  let stringQuote = '';
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1] || '';
    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        result += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === stringQuote) {
        inString = false;
        stringQuote = '';
      }
      continue;
    }
    if (char === '"' || char === '\'') {
      inString = true;
      stringQuote = char;
      result += char;
      continue;
    }
    if (char === '/' && next === '/') {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }
    result += char;
  }
  return result;
}

function parseArgs(args) {
  const options = {
    manifestPath: '',
    envPath: '',
    outputJson: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case '--manifest':
        options.manifestPath = args[++index] || '';
        break;
      case '--env':
      case '--install-env':
        options.envPath = args[++index] || '';
        break;
      case '--json':
        options.outputJson = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!options.manifestPath) {
    throw new Error('full-host-cycle requires --manifest <host.manifest.jsonc>');
  }
  if (!options.envPath) {
    throw new Error('full-host-cycle requires --env <install.env>');
  }
  return options;
}

async function readManifest(manifestPath) {
  const raw = await readFile(manifestPath, 'utf8');
  return JSON.parse(removeJsonComments(raw));
}

function sanitizeName(value) {
  return trimString(value).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}

async function runJsonCommand(args) {
  try {
    const { stdout } = await execFileAsync('node', args, {
      cwd: PROJECT_ROOT,
      maxBuffer: 10 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (error) {
    const stdout = trimString(error?.stdout);
    if (stdout.startsWith('{')) {
      return JSON.parse(stdout);
    }
    throw error;
  }
}

async function ensureCloudflareIngress(manifest) {
  if (trimString(manifest?.network?.ingress?.provider).toLowerCase() !== 'cloudflare') {
    return { manifest, onboarding: null };
  }
  const updated = structuredClone(manifest);
  updated.network ??= {};
  updated.network.ingress ??= {};
  const ingress = updated.network.ingress;
  ingress.ownerHostname = trimString(ingress.ownerHostname || updated.network.ownerDomain);
  ingress.tunnelName = trimString(ingress.tunnelName || updated.host?.hostname);
  ingress.serviceName = trimString(ingress.serviceName || `cloudflared-${sanitizeName(ingress.tunnelName)}`);

  let created = false;
  if (!trimString(ingress.tunnelId) || !trimString(ingress.localCredentialsFile) || !trimString(ingress.credentialsFile)) {
    const { stdout } = await execFileAsync('cloudflared', ['tunnel', 'create', '-o', 'json', ingress.tunnelName], {
      cwd: PROJECT_ROOT,
      maxBuffer: 10 * 1024 * 1024,
    });
    const createdTunnel = JSON.parse(stdout);
    ingress.tunnelId = createdTunnel.id;
    ingress.localCredentialsFile = join(homedir(), '.cloudflared', `${createdTunnel.id}.json`);
    ingress.credentialsFile = `/etc/cloudflared/${createdTunnel.id}.json`;
    created = true;
  }

  await execFileAsync('cloudflared', [
    'tunnel',
    'route',
    'dns',
    '--overwrite-dns',
    ingress.tunnelId,
    ingress.ownerHostname,
  ], {
    cwd: PROJECT_ROOT,
    maxBuffer: 10 * 1024 * 1024,
  });

  return {
    manifest: updated,
    onboarding: {
      provider: 'cloudflare',
      createdTunnel: created,
      tunnelId: ingress.tunnelId,
      tunnelName: ingress.tunnelName,
      ownerHostname: ingress.ownerHostname,
      localCredentialsFile: ingress.localCredentialsFile,
    },
  };
}

async function injectLocalSshAccess(manifest) {
  const updated = structuredClone(manifest);
  updated.host ??= {};
  if (trimString(updated.host.userData) || (Array.isArray(updated.host.sshKeys) && updated.host.sshKeys.length > 0)) {
    return updated;
  }
  const publicKey = trimString(await readFile(`${DEFAULT_SSH_KEY}.pub`, 'utf8'));
  if (trimString(updated.host.provider).toLowerCase() === 'digitalocean') {
    const providerEnv = await readFile('/root/.config/remotelab/providers/digitalocean.env', 'utf8');
    const token = providerEnv.match(/^DIGITALOCEAN_ACCESS_TOKEN=(.+)$/m)?.[1]?.trim();
    if (token) {
      const response = await fetch('https://api.digitalocean.com/v2/account/keys?per_page=200', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const payload = await response.json();
      let sshKey = (payload.ssh_keys || []).find((entry) => trimString(entry.public_key) === publicKey);
      if (!sshKey) {
        const createResponse = await fetch('https://api.digitalocean.com/v2/account/keys', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: `remotelab-root-${Date.now()}`,
            public_key: publicKey,
          }),
        });
        const createPayload = await createResponse.json();
        sshKey = createPayload.ssh_key;
      }
      if (sshKey?.id) {
        updated.host.sshKeys = [sshKey.id];
        return updated;
      }
    }
  }
  updated.host.userData = `#cloud-config
ssh_pwauth: false
chpasswd:
  expire: false
users:
  - name: root
    lock_passwd: true
    ssh_authorized_keys:
      - ${publicKey}
`;
  return updated;
}

async function waitForSsh(host) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await execFileAsync('ssh', [
        '-i', DEFAULT_SSH_KEY,
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=no',
        `root@${host}`,
        'echo ok',
      ], {
        cwd: PROJECT_ROOT,
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      });
      return;
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5000));
    }
  }
  throw new Error(`Timed out waiting for SSH on ${host}`);
}

async function waitForPublicLogin(url) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const { stdout } = await execFileAsync('bash', ['-lc', `curl -fsS ${JSON.stringify(url)} | sed -n '1,5p'`], {
        cwd: PROJECT_ROOT,
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      });
      if (trimString(stdout)) {
        return stdout;
      }
    } catch {
      // wait and retry
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5000));
  }
  throw new Error(`Timed out waiting for public login page at ${url}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let manifest = await readManifest(resolve(options.manifestPath));
  manifest = await injectLocalSshAccess(manifest);
  const { manifest: preparedManifest, onboarding } = await ensureCloudflareIngress(manifest);
  const tempDir = await mkdtemp(join(tmpdir(), 'remotelab-full-host-cycle-'));
  const tempManifestPath = join(tempDir, `${sanitizeName(preparedManifest.host?.hostname || 'host')}.manifest.json`);
  await writeFile(tempManifestPath, `${JSON.stringify(preparedManifest, null, 2)}\n`, 'utf8');

  const provision = await runJsonCommand([
    'cli.js',
    'provision-host',
    '--manifest', tempManifestPath,
    '--provider-env', '/root/.config/remotelab/providers/digitalocean.env',
    '--execute',
    '--wait',
    '--json',
  ]);
  const sshHost = trimString(provision?.execution?.publicIPv4);
  if (!sshHost) {
    throw new Error('Provisioning did not return a public IPv4 address');
  }
  await waitForSsh(sshHost);

  const bootstrap = await runJsonCommand([
    'cli.js',
    'bootstrap-host',
    '--manifest', tempManifestPath,
    '--ssh-host', sshHost,
    '--ssh-key', DEFAULT_SSH_KEY,
    '--execute',
    '--json',
  ]);
  const install = await runJsonCommand([
    'cli.js',
    'install-profile',
    '--manifest', tempManifestPath,
    '--env', resolve(options.envPath),
    '--ssh-host', sshHost,
    '--ssh-key', DEFAULT_SSH_KEY,
    '--execute',
    '--json',
  ]);
  const validate = await runJsonCommand([
    'cli.js',
    'validate-profile',
    '--manifest', tempManifestPath,
    '--env', resolve(options.envPath),
    '--ssh-host', sshHost,
    '--ssh-key', DEFAULT_SSH_KEY,
    '--json',
  ]);

  const publicLoginUrl = `https://${preparedManifest.network.ownerDomain}/login`;
  const publicLoginSnippet = await waitForPublicLogin(publicLoginUrl);
  const result = {
    schemaVersion: 1,
    manifestPath: tempManifestPath,
    ownerDomain: preparedManifest.network.ownerDomain,
    publicLoginUrl,
    ownerAccessUrl: install?.execution?.ownerAccessUrl ?? null,
    sshHost,
    onboarding,
    provision: {
      dropletId: provision?.execution?.dropletId ?? null,
      status: provision?.execution?.status ?? null,
    },
    bootstrap: {
      overallStatus: bootstrap?.summary?.overallStatus ?? null,
    },
    install: {
      overallStatus: install?.summary?.overallStatus ?? null,
    },
    validate: {
      overallStatus: validate?.summary?.overallStatus ?? null,
    },
    publicLoginSnippet,
  };
  process.stdout.write(options.outputJson ? `${JSON.stringify(result, null, 2)}\n` : [
    `ownerDomain: ${result.ownerDomain}`,
    `publicLoginUrl: ${result.publicLoginUrl}`,
    `ownerAccessUrl: ${result.ownerAccessUrl || ''}`,
    `sshHost: ${result.sshHost}`,
    `dropletId: ${result.provision.dropletId}`,
    `validate: ${result.validate.overallStatus}`,
  ].join('\n'));
}

await main();
