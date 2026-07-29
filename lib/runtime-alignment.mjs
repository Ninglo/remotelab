import {
  access,
  lstat,
  mkdir,
  realpath,
  symlink,
  unlink,
} from 'fs/promises';
import { constants } from 'fs';
import { delimiter, join, resolve } from 'path';

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function resolveExistingPath(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

async function replaceWithSymlink(linkPath, targetPath) {
  if (await pathExists(linkPath)) {
    const stats = await lstat(linkPath);
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      throw new Error(`Cannot replace directory with RemoteLab CLI link: ${linkPath}`);
    }
    await unlink(linkPath);
  }
  await symlink(targetPath, linkPath);
}

async function findExecutableOnPath(name, pathValue) {
  for (const directory of String(pathValue || '').split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'EACCES') continue;
      throw error;
    }
  }
  return '';
}

export async function ensureCliAlignment({
  repoRoot,
  homeDir,
  pathValue = process.env.PATH,
  executableName = 'remotelab',
}) {
  const activeRepoRoot = await realpath(resolve(repoRoot));
  const cliPath = join(activeRepoRoot, 'cli.js');
  await access(cliPath, constants.X_OK);

  const changedPaths = [];
  const localBinDirectory = join(resolve(homeDir), '.local', 'bin');
  const localShimPath = join(localBinDirectory, executableName);
  await mkdir(localBinDirectory, { recursive: true });

  if ((await resolveExistingPath(localShimPath)) !== cliPath) {
    await replaceWithSymlink(localShimPath, cliPath);
    changedPaths.push(localShimPath);
  }

  let effectiveCommandPath = await findExecutableOnPath(executableName, pathValue);
  if (!effectiveCommandPath) {
    return {
      activeRepoRoot,
      cliPath,
      localShimPath,
      effectiveCommandPath: '',
      changedPaths,
      warning: `${executableName} is not discoverable on PATH; add ${localBinDirectory} to PATH`,
    };
  }

  if ((await resolveExistingPath(effectiveCommandPath)) !== cliPath) {
    const stats = await lstat(effectiveCommandPath);
    if (!stats.isSymbolicLink()) {
      throw new Error(
        `Refusing to replace non-symlink RemoteLab CLI at ${effectiveCommandPath}; `
        + `remove it or put ${localBinDirectory} earlier on PATH`,
      );
    }
    await replaceWithSymlink(effectiveCommandPath, cliPath);
    changedPaths.push(effectiveCommandPath);
  }

  effectiveCommandPath = await realpath(effectiveCommandPath);
  if (effectiveCommandPath !== cliPath) {
    throw new Error(
      `RemoteLab CLI still resolves to ${effectiveCommandPath}; expected ${cliPath}`,
    );
  }

  return {
    activeRepoRoot,
    cliPath,
    localShimPath,
    effectiveCommandPath,
    changedPaths,
    warning: '',
  };
}

export function parseSystemdShow(output) {
  const result = {};
  for (const line of String(output || '').split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    result[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return result;
}

export function validateServiceAlignment({ repoRoot, serviceState }) {
  const activeRepoRoot = resolve(repoRoot);
  const workingDirectory = resolve(serviceState?.WorkingDirectory || '/');
  const serverPath = join(activeRepoRoot, 'chat-server.mjs');
  const execStart = String(serviceState?.ExecStart || '');
  const fragmentPath = String(serviceState?.FragmentPath || '');

  if (workingDirectory !== activeRepoRoot || !execStart.includes(serverPath)) {
    throw new Error(
      `RemoteLab service checkout ${workingDirectory} does not match the active checkout `
      + `${activeRepoRoot}; rerun setup.sh from the intended checkout before restarting`,
    );
  }

  return {
    fragmentPath,
    workingDirectory,
    serverPath,
  };
}
