import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { createLfLineReader } from '../lib/lf-line-reader.mjs';

test('LF framing preserves UTF-8, Unicode separators, CRLF and final partial lines across byte boundaries', async () => {
  const fixtures = [
    { text: '中文🌏\u2028\u2029\rinside\r\n\nlast\r', expected: ['中文🌏\u2028\u2029\rinside', '', 'last'] },
    { text: '\n', expected: [''] },
    { text: '', expected: [] },
    { text: 'unterminated', expected: ['unterminated'] },
  ];
  for (const { text, expected } of fixtures) {
    const input = Buffer.from(text);
    for (let size = 1; size <= Math.max(1, input.length); size++) {
      const chunks = [];
      for (let offset = 0; offset < input.length; offset += size) chunks.push(input.subarray(offset, offset + size));
      const lines = [];
      await createLfLineReader(Readable.from(chunks), line => lines.push(line)).closed;
      assert.deepEqual(lines, expected, `chunk size ${size}`);
    }
  }
});

test('a fragmented 64 MiB JSON frame arrives intact without quadratic rescanning', { timeout: 15_000 }, async () => {
  const payload = 'x'.repeat(64 * 1024 * 1024) + '中文🌏\u2028\u2029';
  const frame = Buffer.from(JSON.stringify({ text: payload }) + '\nnext\n');
  const stream = Readable.from((async function* () {
    for (let offset = 0; offset < frame.length; offset += 4096) {
      yield frame.subarray(offset, offset + 4096);
      await setImmediate();
    }
  })());
  const lines = [];
  try {
    await createLfLineReader(stream, line => lines.push(line)).closed;
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).text, payload);
    assert.equal(lines[1], 'next');
  } finally {
    stream.destroy();
  }
});

test('read errors reject completion without publishing an incomplete frame', async () => {
  const failure = new Error('stream failed');
  const stream = new Readable({ read() {} });
  const lines = [];
  const reader = createLfLineReader(stream, line => lines.push(line));
  const rejected = assert.rejects(reader.closed, error => error === failure);
  stream.push('partial');
  stream.destroy(failure);
  await rejected;
  assert.deepEqual(lines, []);
});
