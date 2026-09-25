#!/usr/bin/env node
const { existsSync, writeFileSync, unlinkSync } = require('node:fs');
const { join } = require('node:path');

const credential = join(process.env.HOME, 'claude-auth-fixture-credential');
const action = process.argv.slice(2).join(' ');

if (action === 'auth status --json') {
  if (process.env.ANTHROPIC_API_KEY) {
    console.log(JSON.stringify({ loggedIn: true, authMethod: 'api_key' }));
  } else if (existsSync(credential)) {
    console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude_ai' }));
  } else {
    console.log(JSON.stringify({ loggedIn: false, authMethod: 'none' }));
    process.exitCode = 1;
  }
} else if (action === 'auth login --claudeai') {
  if (process.env.ANTHROPIC_API_KEY) process.exit(2);
  process.stdout.write('If the browser did not open, visit: https://claude.com/cai/oauth/authorize?state=fixture\n');
  process.stdout.write('Paste code here if prompted > ');
  process.stdin.once('data', (chunk) => {
    if (String(chunk).trim() !== 'fixture-code') process.exit(3);
    writeFileSync(credential, 'authenticated');
    process.exit(0);
  });
} else if (action === 'auth logout') {
  if (existsSync(credential)) unlinkSync(credential);
} else {
  process.exitCode = 4;
}
