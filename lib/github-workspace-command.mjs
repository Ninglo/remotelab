import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GITHUB_LOGIN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;
const REPOSITORY = /^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/;
const REMOTELAB_SERVICE = /^remotelab(?:[-@][a-zA-Z0-9_.@-]+)?\.service$/;

function usage() {
  return `Usage:
  remotelab github-workspace prepare --unix-user USER --service SERVICE --auth-file PATH --account GITHUB_USER
  remotelab github-workspace activate --unix-user USER --service SERVICE --auth-file PATH --account GITHUB_USER --repo OWNER/REPO --name "Git name" --email VERIFIED_EMAIL [--checkout PATH]
  remotelab github-workspace check --unix-user USER --service SERVICE --auth-file PATH --account GITHUB_USER --repo OWNER/REPO [--checkout PATH]

Run every command as the named Unix user. Each person needs a separate Unix user and RemoteLab runtime.
prepare creates that user's SSH key. The person then runs gh auth login and adds the public key to their own GitHub account. activate checks both identities before cloning and setting Git identity. check is read-only.`;
}

export function parseGithubWorkspaceArgs(argv) {
  const [action, ...rest] = argv;
  if (!action || action === '--help' || action === 'help') return { action: 'help' };
  if (!['prepare', 'activate', 'check'].includes(action)) throw new Error(usage());
  const options = { action };
  const flags = new Map([
    ['--unix-user', 'unixUser'], ['--service', 'service'], ['--auth-file', 'authFile'],
    ['--account', 'account'], ['--repo', 'repo'],
    ['--name', 'name'], ['--email', 'email'], ['--checkout', 'checkout'],
  ]);
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const field = flags.get(flag);
    if (!field || !rest[index + 1] || rest[index + 1].startsWith('--')) {
      throw new Error(`Invalid option ${flag || ''}\n${usage()}`);
    }
    if (options[field]) throw new Error(`Repeated option ${flag}`);
    options[field] = rest[index + 1].trim();
  }
  if (!options.unixUser || !options.service || !options.authFile || !options.account) throw new Error(usage());
  if (!REMOTELAB_SERVICE.test(options.service)) throw new Error('Use a RemoteLab systemd service name');
  if (!isAbsolute(options.authFile)) throw new Error('--auth-file must be an absolute path');
  if (!GITHUB_LOGIN.test(options.account)) throw new Error('Invalid GitHub account name');
  if (action !== 'prepare') {
    if (!options.repo || !REPOSITORY.test(options.repo) || ['.', '..'].includes(options.repo.split('/')[1])) {
      throw new Error('Use --repo OWNER/REPO');
    }
    if (options.checkout && !isAbsolute(options.checkout)) throw new Error('--checkout must be an absolute path');
  }
  if (action === 'activate' && (!options.name || !options.email)) {
    throw new Error('activate requires --name and --email');
  }
  if (options.name && (options.name.length > 100 || /[\x00-\x1f\x7f]/.test(options.name))) {
    throw new Error('Invalid Git display name');
  }
  if (options.email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(options.email) || /[<>]/.test(options.email))) {
    throw new Error('Invalid commit email');
  }
  return options;
}

function isWithin(parent, child) {
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function assertIsolatedUser(options, { identity = userInfo(), env = process.env, uid = process.getuid?.() } = {}) {
  if (uid === 0) throw new Error('Run as the person\'s Unix user, not root');
  if (identity.username !== options.unixUser) {
    throw new Error(`This process runs as ${identity.username}; expected ${options.unixUser}`);
  }
  if (resolve(env.HOME || '') !== resolve(identity.homedir)) {
    throw new Error('HOME does not match this Unix user\'s home directory');
  }
  const overrides = [
    'GH_TOKEN', 'GITHUB_TOKEN', 'GIT_SSH', 'GIT_SSH_COMMAND',
    'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
    'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_GLOBAL',
  ];
  if (overrides.some((key) => env[key])) {
    throw new Error(`Remove account and Git identity overrides (${overrides.join(', ')}) before using this command`);
  }
  if (env.GH_HOST && env.GH_HOST !== 'github.com') throw new Error('GH_HOST must be github.com');
  for (const key of ['GH_CONFIG_DIR', 'XDG_CONFIG_HOME']) {
    if (env[key] && !isWithin(resolve(identity.homedir), resolve(env[key]))) {
      throw new Error(`${key} must stay inside this Unix user's home`);
    }
  }
  return resolve(identity.homedir);
}

async function assertOwnedRegularFile(pathname, uid) {
  const item = await lstat(pathname);
  if (!item.isFile() || item.uid !== uid) throw new Error(`File must belong to the current Unix user: ${pathname}`);
  if (item.mode & 0o077) throw new Error(`File must be private (mode 600): ${pathname}`);
}

async function assertOwnedHome(home, uid) {
  const item = await stat(home);
  if (!item.isDirectory() || item.uid !== uid) throw new Error('Unix home must belong to the current user');
}

export function githubKeyPath(home, account) {
  return join(home, '.ssh', `remotelab-github-${account.toLowerCase()}`);
}

export function checkoutPath(home, options) {
  return resolve(options.checkout || join(home, 'code', options.repo.replace('/', '-')));
}

export function sshCommand(keyPath) {
  return `ssh -i ${shellQuote(keyPath)} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes`;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function capture(command, args, { env = process.env, timeout = 30_000 } = {}) {
  try {
    const result = await execFileAsync(command, args, { env, timeout, maxBuffer: 128 * 1024 });
    return { code: 0, stdout: result.stdout || '', stderr: result.stderr || '' };
  } catch (error) {
    return { code: error.code || 1, stdout: error.stdout || '', stderr: error.stderr || '' };
  }
}

async function required(command, args, label, options) {
  const result = await capture(command, args, options);
  if (result.code !== 0) throw new Error(`${label} failed. Check the account's login and permissions.`);
  return result.stdout.trim();
}

export async function assertIsolatedRuntime(options, home, uid, { commandCapture = capture } = {}) {
  const authPath = resolve(options.authFile);
  if (!isWithin(home, authPath)) throw new Error('Instance auth file must stay inside this Unix user\'s home');
  await assertOwnedRegularFile(authPath, uid);
  const auth = JSON.parse(await readFile(authPath, 'utf8'));
  if (!Array.isArray(auth.people) || auth.people.length !== 1) {
    throw new Error('This RemoteLab instance has multiple People; personal GitHub credentials require a single-person instance');
  }
  const [serviceUser, serviceState] = await Promise.all([
    commandCapture('systemctl', ['show', options.service, '--property=User', '--value']),
    commandCapture('systemctl', ['show', options.service, '--property=ActiveState', '--value']),
  ]);
  if (serviceUser.code !== 0 || serviceUser.stdout.trim() !== options.unixUser) {
    throw new Error('RemoteLab service does not run as the named Unix user');
  }
  if (serviceState.code !== 0 || serviceState.stdout.trim() !== 'active') {
    throw new Error('RemoteLab service must be active before connecting a personal GitHub account');
  }
  return {
    service: options.service,
    remoteLabPersonId: auth.people[0].id || '',
    remoteLabPersonName: auth.people[0].name || '',
  };
}

async function githubLogin() {
  return required('gh', ['api', 'user', '--hostname', 'github.com', '--jq', '.login'], 'GitHub CLI authentication');
}

async function sshLogin(keyPath) {
  const result = await capture('ssh', ['-T', '-i', keyPath, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', 'git@github.com']);
  const match = /Hi ([a-zA-Z0-9-]+)! You've successfully authenticated/.exec(`${result.stdout}\n${result.stderr}`);
  if (!match) throw new Error('GitHub SSH authentication failed. Add the public key to this account and verify the GitHub host key.');
  return match[1];
}

async function assertAccount(account, keyPath) {
  const cliAccount = await githubLogin();
  if (cliAccount.toLowerCase() !== account.toLowerCase()) {
    throw new Error(`GitHub CLI is logged in as ${cliAccount}; expected ${account}`);
  }
  const sshAccount = await sshLogin(keyPath);
  if (sshAccount.toLowerCase() !== account.toLowerCase()) {
    throw new Error(`SSH key authenticates as ${sshAccount}; expected ${account}`);
  }
  return { cliAccount, sshAccount };
}

async function repoPermissions(repo) {
  const raw = await required('gh', ['api', `repos/${repo}`, '--hostname', 'github.com', '--jq', '{full_name,permissions}'], 'Repository permission check');
  const data = JSON.parse(raw);
  if (data.full_name?.toLowerCase() !== repo.toLowerCase()) throw new Error('GitHub returned a different repository');
  const permission = (key) => typeof data.permissions?.[key] === 'boolean' ? data.permissions[key] : null;
  return { read: permission('pull'), push: permission('push'), admin: permission('admin') };
}

async function assertPrivateKey(home, account, uid) {
  const keyPath = githubKeyPath(home, account);
  await assertOwnedRegularFile(keyPath, uid);
  const publicItem = await lstat(`${keyPath}.pub`);
  if (!publicItem.isFile() || publicItem.uid !== uid) throw new Error('SSH public key is missing or owned by another user');
  return keyPath;
}

export async function prepareGithubWorkspace(options, home, uid) {
  const keyPath = githubKeyPath(home, options.account);
  const sshDir = dirname(keyPath);
  await mkdir(sshDir, { recursive: true, mode: 0o700 });
  const sshDirInfo = await lstat(sshDir);
  if (!sshDirInfo.isDirectory() || sshDirInfo.uid !== uid || (sshDirInfo.mode & 0o077)) {
    throw new Error('~/.ssh must be an owned directory with mode 700');
  }
  const fileExists = async (pathname) => lstat(pathname).then(() => true, (error) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  const privateExists = await fileExists(keyPath);
  const publicExists = await fileExists(`${keyPath}.pub`);
  if (privateExists !== publicExists) throw new Error('SSH key pair is incomplete; refusing to overwrite it');
  const exists = privateExists;
  if (exists) await assertPrivateKey(home, options.account, uid);
  if (!exists) {
    await required('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `remotelab-${options.account}@${hostname()}`, '-f', keyPath], 'SSH key creation');
    await assertPrivateKey(home, options.account, uid);
  }
  return {
    unixUser: options.unixUser,
    githubAccount: options.account,
    createdKey: !exists,
    publicKeyPath: `${keyPath}.pub`,
    next: [
      `gh auth login --git-protocol ssh --skip-ssh-key`,
      `gh ssh-key add ${shellQuote(`${keyPath}.pub`)} --type authentication`,
      `ssh -T -i ${shellQuote(keyPath)} -o IdentitiesOnly=yes git@github.com`,
    ],
  };
}

export async function assertCheckoutLocation(home, target, { createParent = false, uid = process.getuid?.() } = {}) {
  const canonicalHome = await realpath(home);
  if (!isWithin(canonicalHome, target)) throw new Error('Checkout must stay inside this Unix user\'s home');
  let current = canonicalHome;
  const components = relative(canonicalHome, dirname(target)).split(sep).filter(Boolean);
  for (const component of components) {
    current = join(current, component);
    if (createParent) await mkdir(current, { mode: 0o700 }).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const item = await lstat(current);
    if (!item.isDirectory() || item.isSymbolicLink() || item.uid !== uid) {
      throw new Error('Checkout parent must be a real directory owned by this Unix user');
    }
  }
  const parent = await realpath(dirname(target));
  if (parent !== canonicalHome && !isWithin(canonicalHome, parent)) {
    throw new Error('Checkout parent resolves outside this Unix user\'s home');
  }
}

async function activate(options, home, uid) {
  const keyPath = await assertPrivateKey(home, options.account, uid);
  const account = await assertAccount(options.account, keyPath);
  const permissions = await repoPermissions(options.repo);
  const target = checkoutPath(home, options);
  await assertCheckoutLocation(home, target, { createParent: true, uid });
  const targetExists = await lstat(target).then(() => true, (error) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (targetExists) throw new Error(`Checkout already exists; refusing to change it: ${target}`);
  const remote = `git@github.com:${options.repo}.git`;
  const env = { ...process.env, GIT_SSH_COMMAND: sshCommand(keyPath) };
  const tempTarget = `${target}.setup-${randomBytes(6).toString('hex')}`;
  try {
    await required('git', ['clone', remote, tempTarget], 'Git clone', { env, timeout: 180_000 });
    const config = [
      ['user.name', options.name], ['user.email', options.email],
      ['user.useConfigOnly', 'true'], ['core.sshCommand', sshCommand(keyPath)],
    ];
    for (const [key, value] of config) await required('git', ['-C', tempTarget, 'config', '--local', key, value], `Git ${key} configuration`);
    await rename(tempTarget, target);
  } catch (error) {
    await rm(tempTarget, { recursive: true, force: true });
    throw error;
  }
  return { unixUser: options.unixUser, githubAccount: account.cliAccount, sshAccount: account.sshAccount, repo: options.repo, checkout: target, permissions, gitName: options.name, gitEmail: options.email, commitEmailVerification: 'not_checked' };
}

async function check(options, home, uid) {
  const keyPath = await assertPrivateKey(home, options.account, uid);
  const account = await assertAccount(options.account, keyPath);
  const permissions = await repoPermissions(options.repo);
  const target = checkoutPath(home, options);
  await assertCheckoutLocation(home, target, { uid });
  const item = await lstat(target);
  if (!item.isDirectory() || item.uid !== uid) throw new Error('Checkout is missing or belongs to another Unix user');
  const read = async (key) => required('git', ['-C', target, 'config', '--local', '--get', key], `Git ${key} read`);
  const [remote, name, email, keyCommand, useConfigOnly] = await Promise.all([
    required('git', ['-C', target, 'remote', 'get-url', 'origin'], 'Git remote read'),
    read('user.name'), read('user.email'), read('core.sshCommand'), read('user.useConfigOnly'),
  ]);
  if (remote !== `git@github.com:${options.repo}.git`) throw new Error('Checkout origin points at a different repository');
  if (keyCommand !== sshCommand(keyPath)) throw new Error('Checkout uses another SSH identity');
  if (useConfigOnly !== 'true') throw new Error('Checkout allows Git identity fallback');
  await required('git', ['-C', target, 'ls-remote', 'origin', 'HEAD'], 'Git SSH repository read');
  return { unixUser: options.unixUser, githubAccount: account.cliAccount, sshAccount: account.sshAccount, repo: options.repo, checkout: target, permissions, gitName: name, gitEmail: email, commitEmailVerification: 'not_checked' };
}

export async function runGithubWorkspaceCommand(argv) {
  const options = parseGithubWorkspaceArgs(argv);
  if (options.action === 'help') {
    console.log(usage());
    return 0;
  }
  const uid = process.getuid?.();
  const home = assertIsolatedUser(options, { uid });
  await assertOwnedHome(home, uid);
  const runtime = await assertIsolatedRuntime(options, home, uid);
  const result = options.action === 'prepare'
    ? await prepareGithubWorkspace(options, home, uid)
    : options.action === 'activate'
      ? await activate(options, home, uid)
      : await check(options, home, uid);
  console.log(JSON.stringify({ ...runtime, ...result }, null, 2));
  return 0;
}
