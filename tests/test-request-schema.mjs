import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureRequestSchema } from '../lib/request-schema.mjs';
const root = await mkdtemp(join(tmpdir(), 'request-schema-'));
try {
  await mkdir(join(root, 'chat-runs', 'run_old'), { recursive: true });
  await assert.rejects(ensureRequestSchema(root), /offline conversion/);
  await rm(join(root, 'chat-runs'), { recursive: true });
  await ensureRequestSchema(root);
  await ensureRequestSchema(root);
  console.log('request schema: old runtime requires explicit conversion; new state initializes once');
} finally { await rm(root, { recursive: true, force: true }); }
