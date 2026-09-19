#!/usr/bin/env node
import { createInterface } from 'readline';
import { hashPasswordAsync } from './lib/auth.mjs';
import { findPerson, updateAuthDocument } from './lib/auth-config.mjs';

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (prompt) => new Promise(resolve => rl.question(prompt, resolve));

const username = (await ask('Username: ')).trim();
const password = (await ask('Password: ')).trim();
rl.close();

if (!username || !password) {
  console.error('Error: username and password cannot be empty.');
  process.exit(1);
}

const passwordHash = await hashPasswordAsync(password);
await updateAuthDocument((document) => {
  const person = findPerson(document, document.primaryPersonId) || document.people[0];
  const existing = person.credentials.find((credential) => credential.type === 'password');
  if (existing) {
    existing.username = username;
    existing.passwordHash = passwordHash;
    existing.label = username;
    existing.lastUsedAt = '';
  } else {
    person.credentials.push({
      id: `credential_password_${Date.now().toString(36)}`,
      type: 'password',
      username,
      passwordHash,
      label: username,
      createdAt: new Date().toISOString(),
    });
  }
});
console.log(`Password set for user "${username}".`);
