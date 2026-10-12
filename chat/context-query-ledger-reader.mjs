import { open } from 'node:fs/promises';

// Newest-first and byte bounded: a busy day's old events must not hide current
// lookups. A split UTF-8 line is decoded only after its buffers are reunited.
export async function* reverseLedgerLines(file, budget) {
  const handle = await open(file, 'r');
  try {
    let position = (await handle.stat()).size, carry = Buffer.alloc(0);
    while (position > 0 && budget.remaining > 0) {
      const length = Math.min(position, budget.remaining, 64 * 1024);
      position -= length; budget.remaining -= length;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead !== length) budget.incomplete = true;
      const data = Buffer.concat([buffer.subarray(0, bytesRead), carry]);
      let end = data.length;
      for (let index = data.lastIndexOf(10); index >= 0; index = data.lastIndexOf(10, index - 1)) {
        if (end > index + 1) yield end - index - 1 > 4096 ? 'x'.repeat(4097) : data.subarray(index + 1, end).toString('utf8');
        end = index;
        if (index === 0) break;
      }
      carry = end > 4096 ? Buffer.alloc(4097, 120) : data.subarray(0, end);
    }
    if (position > 0) budget.incomplete = true;
    else if (carry.length) yield carry.toString('utf8');
  } finally { await handle.close(); }
}
