#!/usr/bin/env node
import { randomBytes } from 'crypto';
import { access, readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { AUTH_FILE, CHAT_PORT } from './lib/config.mjs';
import { findPerson, updateAuthDocument } from './lib/auth-config.mjs';
import { selectCloudflaredAccessDomain } from './lib/cloudflared-config.mjs';

const authFile = AUTH_FILE;

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const token = randomBytes(32).toString('hex');
await updateAuthDocument((document) => {
  const person = findPerson(document, document.primaryPersonId) || document.people[0];
  const existing = person.credentials.find((credential) => credential.type === 'token');
  if (existing) {
    existing.token = token;
    existing.lastUsedAt = '';
  } else {
    person.credentials.push({
      id: `credential_${randomBytes(12).toString('hex')}`,
      type: 'token',
      token,
      label: 'Primary access token',
      createdAt: new Date().toISOString(),
    });
  }
});

// Try to read real domain from cloudflared config
let domain = null;
const cfConfig = join(homedir(), '.cloudflared', 'config.yml');
if (await pathExists(cfConfig)) {
  try {
    const content = await readFile(cfConfig, 'utf8');
    domain = await selectCloudflaredAccessDomain(content, { port: CHAT_PORT });
  } catch {}
}

console.log(`Auth token generated and written to: ${authFile}`);
console.log(`\nYour access token: ${token}`);

if (domain) {
  console.log(`\nAccess URL:`);
  console.log(`  https://${domain}/?token=${token}`);
} else {
  console.log(`\nAccess URL (local):`);
  console.log(`  http://127.0.0.1:${CHAT_PORT}/?token=${token}`);
}
