import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Shared bounded read used by explicit inspection and necessary-context reads.
// The path always comes from registered instance sources, not a request body.
export async function readMemoryDocument(path, limit) {
  let handle;
  try {
    handle = await open(path, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) return { status: 'too-large-or-not-file', path };
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size <= limit) {
      const result = await handle.read(buffer, size, buffer.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > limit) return { status: 'too-large-or-not-file', path };
    const text = buffer.subarray(0, size).toString('utf8');
    return { status: 'available', path, text, modifiedAt: stat.mtime.toISOString(),
      hash: createHash('sha256').update(text).digest('hex').slice(0, 16) };
  } catch (error) {
    return { status: error.code === 'ENOENT' ? 'not-recorded' : 'unavailable', path };
  } finally { await handle?.close(); }
}
