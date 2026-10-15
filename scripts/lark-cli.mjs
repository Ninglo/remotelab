#!/usr/bin/env node
import { spawn, execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { isDocumentCreationCommand, createdDocumentFromResult, recordCreatedDocument } from '../lib/feishu-document-creation.mjs';

const require = createRequire(import.meta.url);
const cli = require.resolve('@larksuite/cli/scripts/run.js');
const args = process.argv.slice(2);
let profile;
if (isDocumentCreationCommand(args)) {
  try {
    const { stdout } = await promisify(execFileCallback)(process.execPath, [cli, 'profile', 'list'],
      { timeout: 10_000, maxBuffer: 100_000 });
    const profiles = JSON.parse(stdout);
    const profileArg = args.find(arg => arg.startsWith('--profile='))?.slice(10)
      || (args.includes('--profile') ? args[args.indexOf('--profile') + 1] : '');
    profile = profiles.find(item => profileArg ? item.name === profileArg : item.active);
    // Pin the identity used for both creation and provenance, even if another
    // process changes the persistent CLI default while this command runs.
    if (profile && !profileArg) args.unshift('--profile', profile.name);
  } catch (error) { console.error(`Comment routing profile discovery failed: ${error.message}`); }
}
const child = spawn(process.execPath, [cli, ...args], { stdio: ['inherit', 'pipe', 'inherit'] });
let output = '', truncated = false;
child.stdout.on('data', chunk => {
  process.stdout.write(chunk);
  if (output.length + chunk.length < 2_000_000) output += chunk.toString();
  else truncated = true;
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('close', async code => {
  process.exitCode = code ?? 1;
  if (code !== 0 || truncated) return;
  let result;
  try { result = JSON.parse(output); } catch { return; }
  const document = createdDocumentFromResult(args, result);
  if (!document) return;
  try {
    const selected = process.env.REMOTELAB_DOCUMENT_SESSION_ID;
    await recordCreatedDocument(document, { appId: profile?.appId,
      sessionId: selected === 'none' ? '' : (selected || process.env.REMOTELAB_SESSION_ID || '') });
  } catch (error) {
    // Creation succeeded: never signal that callers should create it again.
    console.error(`Document created, but comment routing registration failed: ${error.message}. Register the existing document; do not repeat creation.`);
  }
});
