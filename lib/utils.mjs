export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

export function escapeJs(str) {
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/</g, '\\x3c')
    .replace(/>/g, '\\x3e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function readBody(req, maxBytes = 1048576) {
  return new Promise((resolvePromise, reject) => {
    const rawContentLength = Array.isArray(req.headers?.['content-length'])
      ? req.headers['content-length'][0]
      : req.headers?.['content-length'];
    const normalizedContentLength = String(rawContentLength || '').trim();
    const contentLength = /^\d+$/.test(normalizedContentLength)
      ? Number(normalizedContentLength)
      : null;
    const bodyTooLargeError = receivedBytes => Object.assign(
      new Error(`Request body exceeds the ${maxBytes}-byte limit`),
      {
        code: 'BODY_TOO_LARGE',
        maxBytes,
        receivedBytes,
        ...(Number.isSafeInteger(contentLength) ? { contentLength } : {}),
      },
    );

    if (Number.isSafeInteger(contentLength) && contentLength > maxBytes) {
      // Drain the request instead of destroying its socket so the route can
      // return a useful 413 response to the caller.
      req.resume();
      reject(bodyTooLargeError(contentLength));
      return;
    }

    let body = '';
    let size = 0;
    let exceeded = false;

    req.on('data', chunk => {
      if (exceeded) return;
      size += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      if (size > maxBytes) {
        exceeded = true;
        body = '';
        reject(bodyTooLargeError(size));
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (!exceeded) resolvePromise(body);
    });
    req.on('error', error => {
      if (!exceeded) reject(error);
    });
  });
}
