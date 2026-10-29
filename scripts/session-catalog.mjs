#!/usr/bin/env node
import { resolve } from 'node:path';
import { createSessionCatalog } from '../lib/session-catalog.mjs';
const args=process.argv.slice(2), action=args[0], index=args.indexOf('--file');
if (!['migrate','export-legacy','verify','prune'].includes(action) || index<0 || !args[index+1]) {
  console.error('Usage: node scripts/session-catalog.mjs migrate|export-legacy|verify|prune --file <absolute chat-sessions.json> [--offline]'); process.exitCode=1;
} else {
  if (['migrate','export-legacy'].includes(action) && !args.includes('--offline')) throw new Error('Stop metadata writers, then explicitly pass --offline. This command does not stop services.');
  const file=resolve(args[index+1]), store=createSessionCatalog(file);
  const result=action==='migrate'?await store.migrate():action==='export-legacy'?await store.exportLegacy():action==='prune'?await store.prune():{count:(await store.all()).length,indexed:await store.enabled()};
  console.log(JSON.stringify({action,file,...result}));
}
