import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readRecord, writeDurableJson } from './durable-records.mjs';

export const REQUEST_SCHEMA = 1;
export async function ensureRequestSchema(configDir) {
  const path = join(configDir, 'requests', 'schema.json');
  const marker = await readRecord(path);
  if (marker) {
    if (marker.version !== REQUEST_SCHEMA) throw new Error('Unsupported request schema; convert state before starting');
    return;
  }
  const runs = await readdir(join(configDir, 'chat-runs')).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const deliveries = await readRecord(join(configDir, 'chat-source-deliveries.json'));
  if (runs.some(name => name.startsWith('run_')) || deliveries) {
    throw new Error('Legacy runtime state requires offline conversion: scripts/convert-request-state.mjs');
  }
  await writeDurableJson(path, { version: REQUEST_SCHEMA });
}
