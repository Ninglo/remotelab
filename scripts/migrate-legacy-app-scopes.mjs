#!/usr/bin/env node

import { copyFile, readFile } from 'fs/promises';
import { basename, dirname, join } from 'path';
import { CHAT_SESSIONS_FILE } from '../lib/config.mjs';
import { ensureDir, pathExists, writeTextAtomic } from '../chat/fs-utils.mjs';

const APPLY_FLAG = '--apply';
const AUTOMATION_REVIEW_NAME_RE = /^🔧\s*(daily|weekly)\s+review\s+—\s+\d{4}-\d{2}-\d{2}$/i;
const AUTOMATION_REVIEW_DESCRIPTIONS = new Set([
  'Automated Markdown review session for daily memory and tool-reuse patterns.',
  'Automated Markdown review session for weekly memory and tool-reuse patterns.',
]);
const AUTOMATION_REVIEW_GROUPS = new Set(['Daily Review', 'Weekly Review']);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeCurrentAppId(appId) {
  const trimmed = trimString(appId);
  return trimmed ? trimmed.toLowerCase() : '';
}

function formatCurrentAppLabel(appId) {
  const normalized = normalizeCurrentAppId(appId);
  return normalized || '(empty)';
}

function isAutomatedReviewSession(session) {
  const group = trimString(session?.group);
  const name = trimString(session?.name);
  const description = trimString(session?.description);
  if (!AUTOMATION_REVIEW_GROUPS.has(group)) return false;
  if (AUTOMATION_REVIEW_DESCRIPTIONS.has(description)) return true;
  return AUTOMATION_REVIEW_NAME_RE.test(name);
}

function inferTargetAppId(session) {
  const externalTriggerId = trimString(session?.externalTriggerId);
  if (externalTriggerId.startsWith('feishu:')) return 'feishu';
  if (externalTriggerId.startsWith('github:')) return 'github';
  if (externalTriggerId.startsWith('email-thread:')) return 'email';
  if (externalTriggerId.startsWith('mailbox:')) return 'email';
  if (externalTriggerId.startsWith('maintenance:')) return 'automation';
  if (isAutomatedReviewSession(session)) return 'automation';
  return '';
}

function shouldMigrate(session, targetAppId) {
  if (!targetAppId) return false;
  const currentAppId = normalizeCurrentAppId(session?.appId);
  if (!currentAppId) return true;
  return currentAppId === 'chat' && targetAppId !== 'chat';
}

function summarizeByTarget(changes) {
  const counts = new Map();
  for (const change of changes) {
    counts.set(change.toAppId, (counts.get(change.toAppId) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([appId, count]) => `${appId}: ${count}`)
    .join('\n');
}

function nowStamp(date = new Date()) {
  const year = `${date.getFullYear()}`;
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  const hour = `${date.getHours()}`.padStart(2, '0');
  const minute = `${date.getMinutes()}`.padStart(2, '0');
  const second = `${date.getSeconds()}`.padStart(2, '0');
  return `${year}${month}${day}-${hour}${minute}${second}`;
}

async function main() {
  const apply = process.argv.includes(APPLY_FLAG);
  if (!await pathExists(CHAT_SESSIONS_FILE)) {
    throw new Error(`Chat sessions file not found: ${CHAT_SESSIONS_FILE}`);
  }

  const originalText = await readFile(CHAT_SESSIONS_FILE, 'utf8');
  const sessions = JSON.parse(originalText);
  if (!Array.isArray(sessions)) {
    throw new Error(`Expected an array in ${CHAT_SESSIONS_FILE}`);
  }

  const changes = [];
  const nextSessions = sessions.map((session) => {
    const toAppId = inferTargetAppId(session);
    if (!shouldMigrate(session, toAppId)) return session;
    const nextSession = { ...session, appId: toAppId };
    changes.push({
      id: trimString(session?.id),
      name: trimString(session?.name),
      fromAppId: formatCurrentAppLabel(session?.appId),
      toAppId,
      externalTriggerId: trimString(session?.externalTriggerId),
    });
    return nextSession;
  });

  if (changes.length === 0) {
    console.log('No legacy app-scope migrations needed.');
    return;
  }

  console.log(`${apply ? 'Applying' : 'Dry run for'} legacy app-scope migration on ${changes.length} session(s).`);
  console.log(summarizeByTarget(changes));
  for (const change of changes) {
    console.log(`- ${change.id} | ${change.fromAppId} -> ${change.toAppId} | ${change.name || '(unnamed)'}`);
  }

  if (!apply) {
    console.log(`\nRe-run with ${APPLY_FLAG} to persist these changes.`);
    return;
  }

  const latestText = await readFile(CHAT_SESSIONS_FILE, 'utf8');
  if (latestText !== originalText) {
    throw new Error(`Chat sessions file changed during migration: ${CHAT_SESSIONS_FILE}`);
  }

  const backupDir = join(dirname(CHAT_SESSIONS_FILE), 'backups');
  await ensureDir(backupDir);
  const backupPath = join(backupDir, `${basename(CHAT_SESSIONS_FILE, '.json')}-legacy-app-scope-${nowStamp()}.json`);
  await copyFile(CHAT_SESSIONS_FILE, backupPath);
  await writeTextAtomic(CHAT_SESSIONS_FILE, `${JSON.stringify(nextSessions, null, 2)}\n`);
  console.log(`\nBackup written to ${backupPath}`);
  console.log(`Updated ${CHAT_SESSIONS_FILE}`);
}

main().catch((error) => {
  console.error(`[legacy-app-scope-migration] ${error?.stack || error?.message || error}`);
  process.exit(1);
});
