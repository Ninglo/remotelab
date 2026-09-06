# Feishu Markdown rendering verification

Date: 2026-09-06

This scoped record preserves the unrelated, pre-existing root `BUGFIX_VERIFICATION.md`.

## Cause and contract

`buildFeishuPostContent` emitted one `md` paragraph per source line. A valid
GFM table consequently reached Feishu as independent header/delimiter/body
fragments. Native `at` elements also shared rows with `md`, contrary to the
current post message contract. Both ordinary sends and Thread replies use this
renderer, so reply location does not cause the parsing failure.

Verified against the official [post content contract](https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json)
and [reply API](https://open.feishu.cn/document/server-docs/im-v1/message/reply).

## RED

`node scripts/run-with-clean-instance-env.mjs node tests/test-feishu-post-markdown.mjs`
failed before the implementation change:

```text
AssertionError [ERR_ASSERTION]: a GFM table header, delimiter, and body must stay in one Markdown element
```

The screenshot fixture produced ten paragraphs instead of one Markdown element.

## GREEN and regression coverage

- Preserve adjacent Markdown lines, indentation, hard breaks, and task checkboxes.
- Compile known mentions into the inline Markdown extension, leaving code spans literal.
- Keep native fenced-code and formula-image boundaries.
- Test table payload equality for both message create and Thread reply calls.
- Targeted connector, Markdown, and math suites pass.
- JavaScript syntax check and `git diff --check` pass.
- File-size lint exits successfully with the repository's existing advisory warnings.

```text
ok - Feishu preserves GFM blocks, native mentions, code, and formula boundaries
ok - feishu connector helpers
ok - Feishu formulas use standard parsing, image rendering, cache reuse, and safe fallback
```

## Full suite

`npm test` passed (exit 0), including the configured smoke and merge-safety suites.
It ran with a minimal inherited environment and the repository's isolated-test
wrapper. Unrelated work already present in this checkout is preserved and is
not part of this fix.

Live Feishu client rendering is not simulated by these tests. The integration
checks capture actual create/reply request payloads using mock SDK clients and
verify the official post/md contract for both routes.
