#!/usr/bin/env node
/**
 * Tests for the validateOutboundPayload runtime type guard in
 * cloudflare/email-worker/src/index.ts.
 *
 * The TypeScript worker cannot be imported directly into Node.js (it uses
 * cloudflare:email which does not exist in Node.js). The validation logic is
 * therefore duplicated here as plain JS. When updating validateOutboundPayload
 * in index.ts, update this function to match.
 */
import assert from 'assert/strict';

function validateOutboundPayload(payload) {
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

function assertRejects(payload, expectedFragment) {
  const result = validateOutboundPayload(payload);
  assert.ok(result !== null, `Expected rejection for ${JSON.stringify(payload)}, got null`);
  assert.ok(
    result.error.includes(expectedFragment),
    `Expected error containing "${expectedFragment}", got "${result.error}"`,
  );
}

function assertAccepts(payload) {
  const result = validateOutboundPayload(payload);
  assert.equal(result, null, `Expected acceptance for ${JSON.stringify(payload)}, got: ${result?.error}`);
}

// top-level shape
assertRejects(null, 'expected a JSON object');
assertRejects([], 'expected a JSON object');
assertRejects('string', 'expected a JSON object');
assertRejects(42, 'expected a JSON object');

// "to" field
assertRejects({ to: 42 }, '"to" must be a string or array of strings');
assertRejects({ to: {} }, '"to" must be a string or array of strings');
assertRejects({ to: true }, '"to" must be a string or array of strings');
assertRejects({ to: [42] }, '"to[0]" must be a string');
assertRejects({ to: [null] }, '"to[0]" must be a string');
assertRejects({ to: ['alice@example.com', 99] }, '"to[1]" must be a string');

// scalar string fields
assertRejects({ from: 42 }, '"from" must be a string');
assertRejects({ from: [] }, '"from" must be a string');
assertRejects({ subject: 0 }, '"subject" must be a string');
assertRejects({ text: false }, '"text" must be a string');
assertRejects({ inReplyTo: {} }, '"inReplyTo" must be a string');
assertRejects({ references: 123 }, '"references" must be a string');

// "attachments" type (including the specific review example: [42])
assertRejects({ attachments: [42] }, '"attachments[0]" must be an object');
assertRejects({ attachments: [null] }, '"attachments[0]" must be an object');
assertRejects({ attachments: ['string'] }, '"attachments[0]" must be an object');
assertRejects({ attachments: [[]] }, '"attachments[0]" must be an object');
assertRejects({ attachments: 'not an array' }, '"attachments" must be an array');
assertRejects({ attachments: {} }, '"attachments" must be an array');

// attachment entry field types
assertRejects({ attachments: [{ filename: 99 }] }, '"attachments[0].filename" must be a string');
assertRejects({ attachments: [{ contentType: true }] }, '"attachments[0].contentType" must be a string');
assertRejects({ attachments: [{ contentBase64: {} }] }, '"attachments[0].contentBase64" must be a string');
assertRejects(
  { attachments: [{ contentBase64: 'abc' }, { filename: 99 }] },
  '"attachments[1].filename" must be a string',
);

// valid inputs — validation passes, business-logic checks come later
assertAccepts({});
assertAccepts({ to: 'alice@example.com' });
assertAccepts({ to: ['alice@example.com', 'bob@example.com'] });
assertAccepts({ to: [] });
assertAccepts({ from: 'agent@example.com', to: 'alice@example.com', text: 'hello', subject: 'Hi' });
assertAccepts({ text: '' });
assertAccepts({ attachments: [] });
assertAccepts({ attachments: [{}] });
assertAccepts({ attachments: [{ filename: 'f.pdf', contentType: 'application/pdf', contentBase64: 'abc' }] });
assertAccepts({ inReplyTo: '<msg-id@example.com>', references: '<msg-id@example.com>' });

console.log('cloudflare email worker payload validation tests passed');
