// JSONL frames are separated by LF. Keep UTF-8 decoding in the stream, and
// inspect each incoming chunk once instead of rescanning an incomplete frame.
export function createLfLineReader(stream, onLine) {
  let parts = [];
  stream.setEncoding('utf8');
  const emit = line => onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
  const closed = new Promise((resolve, reject) => {
    stream.on('data', chunk => {
      let start = 0, end;
      while ((end = chunk.indexOf('\n', start)) >= 0) {
        parts.push(chunk.slice(start, end));
        const line = parts.join('');
        parts = [];
        emit(line);
        start = end + 1;
      }
      if (start < chunk.length) parts.push(chunk.slice(start));
    });
    stream.once('end', () => {
      if (parts.length) emit(parts.join(''));
      parts = [];
      resolve();
    });
    stream.once('error', reject);
  });
  return { closed };
}
