// Export a pinned contract into an independent consumer; never link its build to an RL checkout.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const target = process.argv[2];
if (!target) throw new Error('Usage: node export-contract.mjs /absolute/consumer-module-directory');
const destination = resolve(target), source = fileURLToPath(new URL('.', import.meta.url));
await mkdir(destination, { recursive: true });
const hashes = {};
for (const file of ['contract.mjs', 'contract.d.mts']) {
  const data = await readFile(join(source, file));
  await writeFile(join(destination, file), data);
  hashes[file] = createHash('sha256').update(data).digest('hex');
}
await writeFile(join(destination, 'contract-source.json'), JSON.stringify({ source: 'RemoteLab integrations/agent-monitor', schema: 1, sha256: hashes }, null, 2) + '\n');
console.log(JSON.stringify({ destination, schema: 1, sha256: hashes }));
