#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { resolveExecutableCommandPathAsync } from '../lib/user-shell-env.mjs';

async function main() {
  const home = join(CONFIG_DIR, 'provider-runtime-homes', 'claude-topic-pilot');
  const profilePath = join(home, 'profile.json');
  if (((await stat(profilePath)).mode & 0o077) !== 0) throw new Error('insecure profile permissions');
  const { baseUrl, authToken } = JSON.parse(await readFile(profilePath, 'utf8'));
  if (typeof authToken !== 'string' || !authToken.trim()) throw new Error('invalid profile');
  const endpoint = new URL(baseUrl);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('invalid endpoint');
  const args = process.argv.slice(2);
  const claude = await resolveExecutableCommandPathAsync('claude');
  if (!claude) throw new Error('Claude Code unavailable');
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(ANTHROPIC_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_USE_)/.test(name)));
  process.execve(claude, [claude, ...args], {
    ...env,
    ANTHROPIC_BASE_URL: endpoint.href.replace(/\/$/, ''),
    ANTHROPIC_AUTH_TOKEN: authToken,
    CLAUDE_CONFIG_DIR: home,
    API_TIMEOUT_MS: '600000',
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_AUTO_MODE_SERVER: '0',
  });
}

try { await main(); }
catch {
  // Never include profile contents, environment values or raw exceptions in the runner log.
  console.error('Claude provider: invalid or missing configuration, or Claude Code could not start.');
  process.exitCode = 1;
}
