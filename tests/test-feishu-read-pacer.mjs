import assert from 'node:assert/strict';
import { createFeishuReadPacer } from '../lib/feishu-read-pacer.mjs';
import { readFeishuCommentThread } from '../connectors/feishu/comment-flow.mjs';

let clock = 0;
const starts = [], waits = [];
const pace = createFeishuReadPacer({ now: () => clock, wait: async ms => { waits.push(ms); clock += ms; } });
await Promise.all(Array.from({ length: 20 }, () => pace(async () => { starts.push(clock); return { code: 0 }; })));
assert.deepEqual(starts, Array.from({ length: 20 }, (_, i) => i * 400), 'fast concurrent reads still obey the shared request interval');
const limitedAt = clock + 400;
await assert.rejects(pace(async () => { throw Object.assign(new Error('rate limited'), { code: 99991400, retryAfterMs: 12_000 }); }));
await Promise.all([pace(async () => { starts.push(clock); return { code: 0 }; }),
  pace(async () => { starts.push(clock); return { code: 0 }; })]);
assert.equal(starts.at(-2), limitedAt + 12_000, 'a rate limit pauses all queued reads, honoring Retry-After');
assert.equal(starts.at(-1) - starts.at(-2), 800, 'the steady request interval backs off too');
await pace(async () => ({ code: 99991400 }));
await pace(async () => { starts.push(clock); return { code: 0 }; });
assert.equal(waits.at(-1), 5000, 'business-error responses share the same cooldown');

clock = 0; const pages = [];
const read = createFeishuReadPacer({ now: () => clock, wait: async ms => { clock += ms; } });
const runtime = { appClient: { drive: { v1: {
  fileComment: { batchQuery: async () => { pages.push(['comment', clock]); return { data: { items: [{ comment_id: 'c' }] } }; } },
  fileCommentReply: { list: async ({ params }) => { pages.push(['replies', clock]); return { data: params.page_token
    ? { items: [{ reply_id: 'r' }] } : { items: [], has_more: true, page_token: 'next' } }; } },
} } } };
await readFeishuCommentThread(runtime, { fileToken: 'doc', fileType: 'docx', commentId: 'c', replyId: 'r' }, read);
assert.deepEqual(pages, [['comment', 0], ['replies', 400], ['replies', 800]], 'scoped comment read and reply pagination use one shared pacer');
console.log('Feishu document read pacing: concurrent starts, shared pagination, rate-limit cooldown and adaptive interval pass');
