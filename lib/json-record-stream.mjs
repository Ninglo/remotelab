import { open } from 'node:fs/promises';

// Read a legacy { records: { key: value } } snapshot without retaining its map.
// JSON.parse validates each complete value; the envelope is validated here.
export async function* readJsonRecords(pathname) {
  const file = await open(pathname, 'r');
  const stream = file.createReadStream({ encoding: 'utf8', highWaterMark: 64 * 1024 });
  const chunks = stream[Symbol.asyncIterator]();
  let buffer = '', offset = 0, ended = false;
  async function peek() {
    while (offset === buffer.length && !ended) {
      const next = await chunks.next();
      buffer = next.value || ''; offset = 0; ended = next.done;
    }
    return buffer[offset];
  }
  async function whitespace() { while (/[ \t\r\n]/.test((await peek()) || 'x')) offset++; }
  async function expect(character) {
    await whitespace();
    if (await peek() !== character) throw new SyntaxError(`Expected ${character} in ${pathname}`);
    offset++;
  }
  async function value() {
    await whitespace();
    let text = '', depth = 0, quoted = false, escaped = false;
    for (;;) {
      if (offset === buffer.length) await peek();
      const c = buffer[offset];
      if (c === undefined || (!quoted && depth === 0 && /[,}: \t\r\n]/.test(c))) break;
      text += c; offset++;
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') depth--;
      if (depth < 0) throw new SyntaxError(`Invalid JSON nesting in ${pathname}`);
    }
    return JSON.parse(text);
  }
  async function* members(records) {
    await expect('{'); await whitespace();
    if (await peek() === '}') { offset++; return; }
    for (;;) {
      const key = await value();
      if (typeof key !== 'string') throw new SyntaxError('JSON object key must be a string');
      await expect(':');
      if (!records && key === 'records') yield* members(true);
      else {
        const record = await value();
        if (records) yield [key, record];
      }
      await whitespace();
      const delimiter = await peek(); offset++;
      if (delimiter === '}') return;
      if (delimiter !== ',') throw new SyntaxError('Expected JSON object delimiter');
    }
  }
  try {
    yield* members(false);
    await whitespace();
    if (await peek() !== undefined) throw new SyntaxError('Trailing JSON content');
  } finally { stream.destroy(); await file.close(); }
}
