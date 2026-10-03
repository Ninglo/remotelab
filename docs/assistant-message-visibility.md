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

Web display and the Connector outbox use `lib/assistant-surface-messages.mjs` for selection. Live publication queues the opening before execution ends. In conversations with workboard presentation enabled, tagged progress updates one shared area: the acceptance card when present, otherwise a compact progress panel per Run. A later acceptance list upgrades that original position and Feishu message. Progress panels contain no checklist, item count or inferred work completion. Other conversations retain separate progress messages. Feishu holds final replies until execution stops; other connectors can publish phase-marked finals immediately. Receipt IDs and delivery parts are committed together in the Request record, so observer replay and restart do not enqueue the same message twice. Existing thread targets, attachment transport, final reactions, and failed-Run notices remain part of the normal delivery path. An intermediate message is never a task-completion receipt.

For adapters without message phases, Web can show a first reply before tool execution as an opening. Feishu publication waits for the terminal answer unless the Harness explicitly marks progress: a phase-less direct answer cannot safely be classified as an opening while execution continues. Existing stored history is projected on read rather than rewritten. An updated per-turn prompt teaches the format to both fresh and resumed Harness threads.

Verification: `tests/test-assistant-surface-messages.mjs`, `tests/test-session-display-events.mjs`, and `tests/test-reply-publication.mjs`. The integration fixture holds execution until the opening and tagged progress are claimed, then releases the final answer and verifies there are no duplicate deliveries.

## Shared Feishu message labels (trial)

Feishu assistant replies receive a deterministic prefix in the durable outbox: `【进展】` while the current execution is running, and `【交付】` once it has stopped, including terminal fallback publication and replies fanned out to another destination. The backend supplies this state; message text and model-chosen phase do not select a label. An early final answer is held for terminal publication so a running execution cannot announce `【交付】`. The trial applies to all readers, with no personal setting. Original history, Web message text, other connectors, manually queued notices, reactions, and attachment-only deliveries retain their existing behavior.

There are exactly two labels and no label instructions in the model prompt. The previous `【待你确认】` exception is removed; legacy leading prefixes are normalized to the actual execution state. `【交付】` means this execution stopped, not that the user's task succeeded. Labels do not publish hidden commentary or justify additional messages.
