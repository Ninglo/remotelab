#!/usr/bin/env node
// Operator-only bounded probe. No polling, binding mutation, AI run, or text message.
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createRuntimeContext, createTypingApiForRuntime, getStoredContextToken,
  loadConfig, resolveDefaultWeChatTarget,
} from './wechat-connector.mjs';

export async function checkTyping({ api, summary, sleep = delay }) {
  const result = { ok: false, configAvailable: false, startAccepted: false,
    cancelAccepted: false, readReceipt: false, clientVisibilityVerified: false };
  let ticket = '';
  let attempted = false;
  try {
    const config = await api.getConfig(summary);
    result.configAvailable = true;
    result.configFields = Object.keys(config);
    ticket = typeof config.typing_ticket === 'string' ? config.typing_ticket.trim() : '';
    if (!ticket) {
      result.failureStage = 'typing_ticket_unavailable';
      return result;
    }
    attempted = true;
    await api.sendTyping(summary, ticket, 1);
    result.startAccepted = true;
    await sleep(2000);
  } catch {
    result.failureStage = result.configAvailable ? 'typing_start_failed' : 'getconfig_failed';
  } finally {
    // A timed-out start may already have reached WeChat: always attempt cancellation.
    if (attempted) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await api.sendTyping(summary, ticket, 2);
          result.cancelAccepted = true;
          break;
        } catch { /* Only sanitized aggregate status leaves this connector process. */ }
      }
      if (!result.cancelAccepted) result.failureStage = 'typing_cancel_failed';
    }
  }
  result.ok = result.startAccepted && result.cancelAccepted;
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--config' || !args[1])) {
    throw new Error('usage');
  }
  const config = await loadConfig(args[1]);
  const runtime = createRuntimeContext(config);
  const target = await resolveDefaultWeChatTarget(runtime);
  const summary = { ...target,
    contextToken: getStoredContextToken(runtime.contextTokensDoc, target.accountId, target.peerUserId) };
  const result = await checkTyping({ api: createTypingApiForRuntime(runtime), summary });
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(() => {
    console.error(JSON.stringify({ ok: false, failureStage: 'configuration_or_binding',
      usage: 'node scripts/wechat-typing-check.mjs [--config <instance-wechat-config>]' }));
    process.exitCode = 1;
  });
}
