#!/usr/bin/env node
import { resolve } from 'node:path';
import { createSessionCatalog } from '../lib/session-catalog.mjs';
const args=process.argv.slice(2), action=args[0], index=args.indexOf('--file');
if (!['migrate','export-legacy','verify','prune','reference-status','enable-references','disable-empty-references'].includes(action) || index<0 || !args[index+1]) {
  console.error('Usage: node scripts/session-catalog.mjs migrate|export-legacy|verify|prune|reference-status|enable-references|disable-empty-references --file <absolute chat-sessions.json> [--offline]'); process.exitCode=1;
} else {
  if (['migrate','export-legacy','enable-references','disable-empty-references'].includes(action) && !args.includes('--offline')) throw new Error('Stop metadata writers, then explicitly pass --offline. This command does not stop services.');
  const file=resolve(args[index+1]), store=createSessionCatalog(file);
  const status=async()=>{const {data}=await store.snapshot(); return {schema:data.schema || 'legacy-array',nativeCount:data.order?.length ?? data.length,referenceCount:Object.keys(data.externalRefs || {}).length,revision:data.revision ?? null};};
  const result=action==='reference-status'?await status():action==='enable-references'?{changed:await store.enableReferences(),...await status()}:action==='disable-empty-references'?{changed:await store.disableEmptyReferences(),...await status()}:action==='migrate'?await store.migrate():action==='export-legacy'?await store.exportLegacy():action==='prune'?await store.prune():{count:(await store.all()).length,indexed:await store.enabled()};
  console.log(JSON.stringify({action,file,...result}));
}
