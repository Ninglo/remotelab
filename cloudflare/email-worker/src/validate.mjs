/**
 * Runtime type guard for OutboundSendPayload.
 * Plain JS so it can be imported by both index.ts (via esbuild/wrangler)
 * and Node.js tests without requiring the cloudflare:email runtime.
 *
 * @param {unknown} payload
 * @returns {{ error: string } | null}
 */
export function validateOutboundPayload(payload) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { error: 'Invalid payload: expected a JSON object' };
  }

  for (const field of ['from', 'subject', 'text', 'inReplyTo', 'references']) {
    if (field in payload && typeof payload[field] !== 'string') {
      return { error: `Invalid payload: "${field}" must be a string` };
    }
  }

  if ('to' in payload) {
    const to = payload['to'];
    if (typeof to === 'string') {
      // valid
    } else if (Array.isArray(to)) {
      for (let i = 0; i < to.length; i++) {
        if (typeof to[i] !== 'string') {
          return { error: `Invalid payload: "to[${i}]" must be a string` };
        }
      }
    } else {
      return { error: 'Invalid payload: "to" must be a string or array of strings' };
    }
  }

  if ('attachments' in payload) {
    const attachments = payload['attachments'];
    if (!Array.isArray(attachments)) {
      return { error: 'Invalid payload: "attachments" must be an array' };
    }
    for (let i = 0; i < attachments.length; i++) {
      const entry = attachments[i];
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        return { error: `Invalid payload: "attachments[${i}]" must be an object` };
      }
      for (const field of ['filename', 'contentType', 'contentBase64']) {
        if (field in entry && typeof entry[field] !== 'string') {
          return { error: `Invalid payload: "attachments[${i}].${field}" must be a string` };
        }
      }
    }
  }

  return null;
}
