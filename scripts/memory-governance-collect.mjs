#!/usr/bin/env node
// Manual test collector only. No foreground hooks, provider calls, delivery or formal writes.
import { chmod, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateWorkspace } from './memory-governance-preflight.mjs';
import { captureGovernance } from './memory-governance-capture.mjs';
import { runGovernanceSandbox } from './memory-governance-sandbox.mjs';

const worker = fileURLToPath(new URL('./memory-governance-worker.mjs', import.meta.url));
export async function collectGovernance({ plan, workspace, protectedRoots }) {
  const { root } = await validateWorkspace(workspace, protectedRoots);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root,0o700);
  const lock = join(root, '.capture-lock');
  await mkdir(lock, { mode: 0o700 });
  try {
    for (const d of ['input','output']) {
      const p = join(root,d);
      await mkdir(p, { mode: 0o700 }).catch(e => { if(e.code !== 'EEXIST') throw e; });
      if (await realpath(p) !== p) throw new Error('Workspace subdirectory alias rejected.');
      await chmod(p,0o700);
    }
    const corpus = await captureGovernance(plan);
    const workerBytes = await readFile(worker);
    corpus.workerHash = createHash('sha256').update(workerBytes).digest('hex');
    const input = join(root,'input');
    await writeFile(join(input,'corpus.next'), JSON.stringify(corpus), { mode: 0o600, flag: 'wx' });
    await rename(join(input,'corpus.next'),join(input,'corpus.json'));
    await writeFile(join(input,'worker.next'), workerBytes, { mode: 0o600, flag: 'wx' });
    await rename(join(input,'worker.next'),join(input,'worker.mjs'));
    await writeFile(join(root,'policy.next'), JSON.stringify({ schemaVersion: 1, stage: 'isolated-test',
      permissions: { collection: true, foregroundRetrieval: false, formalWrites: false, delivery: false, skillPromotion: false, businessActions: false },
      resources: { modelCalls: 0, workerConcurrencyPerWorkspace: 1, workerCpuSeconds: 30, workerWallSeconds: 65, workerAddressSpaceMiB: 2048, projectedCorpusMiB: 32 },
      scope: 'All registered projects; per-source gaps remain explicit.' },null,2)+'\n', {mode:0o600, flag:'wx'});
    await rename(join(root,'policy.next'),join(root,'policy.json'));
    const result = await runGovernanceSandbox({ workspace: root, protectedRoots });
    return { ...JSON.parse(result.stdout.trim()), capturedSourceBytes: corpus.inventory.capturedSourceBytes,
      omissions: corpus.sources.map(s=>({ id:s.id,omitted:s.omitted,selected:s.selected,reusedOriginals:s.reusedOriginals || 0 })) };
  } finally { await rm(lock,{recursive:true,force:true}); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === '--help') {
    console.log('Manual isolated test: node scripts/memory-governance-collect.mjs --plan /absolute/plan.json --workspace /absolute/private-test-directory\nLinux namespaces required; fails closed. See docs/memory-governance-collection.md.');
  } else {
    if (args.length !== 4 || args[0] !== '--plan' || args[2] !== '--workspace') throw new Error('Use --help for the fixed command shape.');
    const base = homedir();
    const protectedRoots = [join(base,'.config/remotelab'),join(base,'.remotelab/memory'),join(base,'.codex'),
      join(base,'.remotelab/workspace/project-knowledge'),join(base,'.remotelab/workspace/project-review'),
      dirname(dirname(worker)), ...(process.env.REMOTELAB_PROJECT_ROOT ? [process.env.REMOTELAB_PROJECT_ROOT] : [])];
    const plan = JSON.parse(await readFile(args[1],'utf8'));
    console.log(JSON.stringify(await collectGovernance({ plan, workspace: args[3], protectedRoots }),null,2));
  }
}
