import assert from 'node:assert/strict';
import { lstat, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertCheckoutLocation,
  assertIsolatedRuntime,
  assertIsolatedUser,
  githubKeyPath,
  parseGithubWorkspaceArgs,
  prepareGithubWorkspace,
  sshCommand,
} from '../lib/github-workspace-command.mjs';

const home = await mkdtemp(join(tmpdir(), 'remotelab-github-workspace-'));
const outside = await mkdtemp(join(tmpdir(), 'remotelab-github-outside-'));
const uid = process.getuid();

try {
  const parsed = parseGithubWorkspaceArgs([
    'activate', '--unix-user', 'alice', '--service', 'remotelab-alice.service',
    '--auth-file', join(home, 'auth.json'), '--account', 'alice-gh',
    '--repo', 'Example/project', '--name', 'Alice', '--email', 'alice@example.com',
  ]);
  assert.equal(parsed.account, 'alice-gh');
  assert.equal(parsed.repo, 'Example/project');
  assert.throws(() => parseGithubWorkspaceArgs(['activate', '--unix-user', 'alice', '--service', 'remotelab-alice.service', '--auth-file', join(home, 'auth.json'), '--account', 'alice', '--repo', '../..', '--name', 'A', '--email', 'a@example.com']), /Use --repo/);
  assert.throws(() => parseGithubWorkspaceArgs(['prepare', '--unix-user', 'alice', '--service', 'remotelab-alice.service', '--auth-file', join(home, 'auth.json'), '--account', 'bad/account']), /Invalid GitHub account/);

  assert.equal(assertIsolatedUser({ unixUser: 'alice' }, {
    identity: { username: 'alice', homedir: home }, env: { HOME: home }, uid,
  }), home);
  assert.throws(() => assertIsolatedUser({ unixUser: 'alice' }, {
    identity: { username: 'shared', homedir: home }, env: { HOME: home }, uid,
  }), /expected alice/);
  assert.throws(() => assertIsolatedUser({ unixUser: 'alice' }, {
    identity: { username: 'alice', homedir: home }, env: { HOME: home, GH_TOKEN: 'hidden' }, uid,
  }), /Remove account and Git identity overrides/);
  assert.throws(() => assertIsolatedUser({ unixUser: 'alice' }, {
    identity: { username: 'alice', homedir: home }, env: { HOME: home, GH_CONFIG_DIR: outside }, uid,
  }), /GH_CONFIG_DIR/);

  const authFile = join(home, 'auth.json');
  const runtime = { unixUser: 'alice', service: 'remotelab-alice.service', authFile };
  const serviceCapture = async (_command, args) => ({ code: 0, stdout: args.includes('--property=User') ? 'alice\n' : 'active\n' });
  await writeFile(authFile, JSON.stringify({ people: [{ id: 'alice' }] }), { mode: 0o600 });
  assert.deepEqual(await assertIsolatedRuntime(runtime, home, uid, { commandCapture: serviceCapture }), { service: runtime.service, remoteLabPersonId: 'alice', remoteLabPersonName: '' });
  await writeFile(authFile, JSON.stringify({ people: [{ id: 'alice' }, { id: 'bob' }] }));
  await assert.rejects(assertIsolatedRuntime(runtime, home, uid, { commandCapture: serviceCapture }), /multiple People/);
  await writeFile(authFile, JSON.stringify({ people: [{ id: 'alice' }] }));
  await assert.rejects(assertIsolatedRuntime(runtime, home, uid, { commandCapture: async () => ({ code: 0, stdout: 'shared\n' }) }), /does not run/);

  const prepared = await prepareGithubWorkspace({ unixUser: 'alice', account: 'alice-gh' }, home, uid);
  const key = githubKeyPath(home, 'alice-gh');
  assert.equal(prepared.createdKey, true);
  assert.equal((await lstat(key)).mode & 0o077, 0);
  assert.equal((await lstat(join(home, '.ssh'))).mode & 0o077, 0);
  assert.equal((await prepareGithubWorkspace({ unixUser: 'alice', account: 'alice-gh' }, home, uid)).createdKey, false);
  assert.match(sshCommand(key), /IdentitiesOnly=yes/);
  await unlink(`${key}.pub`);
  await assert.rejects(prepareGithubWorkspace({ unixUser: 'alice', account: 'alice-gh' }, home, uid), /incomplete/);

  await assertCheckoutLocation(home, join(home, 'code', 'Example-project'), { createParent: true, uid });
  await symlink(outside, join(home, 'escape'));
  await assert.rejects(assertCheckoutLocation(home, join(home, 'escape', 'project'), { createParent: true, uid }), /real directory/);
  await assert.rejects(assertCheckoutLocation(home, join(outside, 'project'), { createParent: true, uid }), /inside this Unix user's home/);
  console.log('github workspace command tests passed');
} finally {
  await rm(home, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
}
