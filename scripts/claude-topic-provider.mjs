#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { findSessionMeta } from '../chat/session-meta-store.mjs';
import { resolveExecutableCommandPathAsync } from '../lib/user-shell-env.mjs';

async function main() {
  const home = join(CONFIG_DIR, 'provider-runtime-homes', 'claude-topic-pilot');
  const profilePath = join(home, 'profile.json');
  if (((await stat(profilePath)).mode & 0o077) !== 0) throw new Error('insecure profile permissions');
  const { chatId, sourceRouteId, creatorIdentityId, notBefore, baseUrl, authToken } = JSON.parse(await readFile(profilePath, 'utf8'));
  if (![chatId, sourceRouteId, creatorIdentityId, authToken].every(value => typeof value === 'string' && value.trim())) throw new Error('invalid profile');
  const endpoint = new URL(baseUrl);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('invalid endpoint');
  const args = process.argv.slice(2);
  if (!process.env.REMOTELAB_SESSION_ID || !process.env.REMOTELAB_REQUEST_ID) throw new Error('missing request scope');
  const session = await findSessionMeta(process.env.REMOTELAB_SESSION_ID);
  const conversation = session?.conversation;
  if (conversation?.connector !== 'feishu' || conversation.sourceRouteId !== sourceRouteId
    || conversation.target?.chatId !== chatId || conversation.target?.conversationKind !== 'thread'
    || session.creatorIdentityId !== creatorIdentityId || !(Date.parse(session.created) >= Date.parse(notBefore))) {
    throw new Error('request outside pilot scope');
  }
  const claude = await resolveExecutableCommandPathAsync('claude');
  if (!claude) throw new Error('Claude Code unavailable');
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(ANTHROPIC_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_USE_)/.test(name)));
  process.chdir(home);
  process.execve(claude, [claude, ...args, '--setting-sources', 'user', '--strict-mcp-config', '--tools', ''], {
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
  console.error('Claude provider pilot: invalid or missing setup, or request outside the allowed new topics.');
  process.exitCode = 1;
}
