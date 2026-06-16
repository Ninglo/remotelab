#!/usr/bin/env node
import { chmodSync, chownSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const GUEST_ROOT = '/var/lib/remotelab-guests';
const FIX_MODE = process.argv.includes('--fix');
const DESIRED_MODE = 0o600;

function octalMode(value) {
  return `0${(value & 0o777).toString(8)}`;
}

function auditInstance(name) {
  const codexDir = join(GUEST_ROOT, name, 'config', 'provider-runtime-homes', 'codex');
  const authFile = join(codexDir, 'auth.json');
  if (!existsSync(codexDir) || !existsSync(authFile)) {
    return null;
  }

  const dirStat = statSync(codexDir);
  const authStat = statSync(authFile);
  const ownerMismatch = dirStat.uid !== authStat.uid || dirStat.gid !== authStat.gid;
  const modeMismatch = (authStat.mode & 0o777) !== DESIRED_MODE;
  if (!ownerMismatch && !modeMismatch) {
    return null;
  }

  const issue = {
    name,
    authFile,
    dirOwner: `${dirStat.uid}:${dirStat.gid}`,
    fileOwner: `${authStat.uid}:${authStat.gid}`,
    mode: octalMode(authStat.mode),
    issues: [
      ...(ownerMismatch ? ['owner-mismatch'] : []),
      ...(modeMismatch ? [`mode-${octalMode(authStat.mode)}`] : []),
    ],
  };

  if (FIX_MODE) {
    if (ownerMismatch) {
      chownSync(authFile, dirStat.uid, dirStat.gid);
    }
    if (modeMismatch) {
      chmodSync(authFile, DESIRED_MODE);
    }
    const fixedStat = statSync(authFile);
    issue.fixed = {
      fileOwner: `${fixedStat.uid}:${fixedStat.gid}`,
      mode: octalMode(fixedStat.mode),
    };
  }

  return issue;
}

const results = [];
for (const name of existsSync(GUEST_ROOT) ? readdirSync(GUEST_ROOT) : []) {
  const issue = auditInstance(name);
  if (issue) {
    results.push(issue);
  }
}

console.log(JSON.stringify({
  guestRoot: GUEST_ROOT,
  fixMode: FIX_MODE,
  issuesFound: results.length,
  issues: results,
}, null, 2));
