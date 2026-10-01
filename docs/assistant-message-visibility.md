# Assistant messages on Web and Connectors

When a task needs investigation or tools, readers get a short opening immediately and the final conclusion when it is ready. Additional useful findings can be published with `<progress>...</progress>`. Other intermediate assistant messages stay in the Web UI's expandable process record.

For example:

```text
I will check where replies are filtered.                 → opening: shown
I am reading another implementation file.                → intermediate: folded
<progress>The first reply is being filtered out.</progress> → progress: shown
The fix is deployed and the checks passed.                → final: shown
```

The first assistant reply and explicit final messages need no tag. A simple question may have just one direct answer. `<progress>` is for a useful finding, changed direction, blocker, or required input; elapsed time alone is not a reason to publish.

Only complete progress blocks in assistant messages are recognized. Multiple blocks are joined in order, and untagged text around them is omitted from the displayed message; the original event remains in history. Tags inside Markdown code examples are literal text. `<private>` and `<hide>` content stays hidden. Reasoning and tool output cannot become public by containing this tag. Finals retain their full public text, with actual progress wrappers removed.

Web display and the Connector outbox use `lib/assistant-surface-messages.mjs` for selection. Live publication queues the opening, tagged progress, and phase-marked finals before the Run ends. Receipt IDs and delivery parts are committed together in the Request record, so observer replay and restart do not enqueue the same message twice. Existing thread targets, attachment transport, final reactions, and failed-Run notices remain part of the normal delivery path. An intermediate message is never a task-completion receipt.

For adapters without message phases, only a first reply before tool execution is treated as an opening; their last answer uses terminal publication. Existing stored history is projected on read rather than rewritten. An updated per-turn prompt teaches the format to both fresh and resumed Harness threads.

Verification: `tests/test-assistant-surface-messages.mjs`, `tests/test-session-display-events.mjs`, and `tests/test-reply-publication.mjs`. The integration fixture holds execution until the opening and tagged progress are claimed, then releases the final answer and verifies there are no duplicate deliveries.
