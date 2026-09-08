# Transcript activity interactions

The activity surface is rendered by `static/chat/activity-ui.js` and `activity.css`.
`ui.js` routes timeline events; the activity module owns only DOM disclosure state.
No history rewrite is needed to upgrade existing conversations.

| Event | Collapsed presentation | Expanded presentation |
| --- | --- | --- |
| Tool start/update/result | One command or argument summary, tool name, state | Output and full call details, switchable without duplicated blocks |
| File change | Basename and change kind or added/removed counts | Full path and literal, colored patch lines when supplied |
| Reasoning | Reasoning disclosure | Markdown and deferred full body |
| Plan (`todo_list`) | Plan disclosure | Checklist |
| Assistant commentary | Normal readable message within activity | No redundant timestamp within the activity block |
| Manager context / context operation | Title and phase | Summary, content and reason |
| Provider notice / error | Bounded summary; failures accented | Full notice |
| Context barrier | Quiet divider | No hidden operation |
| Usage | Low-emphasis token summary | Exact values on hover; composer context remains authoritative |
| Unknown event | Details disclosure | Literal JSON; never interpreted as HTML |

## Identity and lifecycle

Codex emits command starts again at completion. All three adapters now preserve
`toolCallId`; the renderer matches `(runId, toolCallId)` and updates the existing
row. This is deterministic across projection restarts, unlike an adapter-local
pending map. Parallel calls with identical arguments stay separate; out-of-order
results resolve by identity. Share serialization preserves the same identity.

Legacy histories have no call IDs. Adjacent identical pending calls are collapsed,
and results match pending calls by tool name within the run. This cannot recover
arbitrary historical concurrency that was never recorded; it deliberately does
not merge already completed repeated commands. Missing starts retain their output.
Finished blocks settle unresolved tools to “No result recorded”, never fake success.

Native details/summary elements provide keyboard disclosures. User-selected tabs
and mounted bodies survive incremental updates. Input remains available after
completion; text output and diffs are inserted as text, not HTML.

## Diff evidence boundary

The Codex runner captures native completion patches into durable run output;
history stores an independent body with no age-based expiry. File rows fetch the
saved body only when opened; shares preserve the patch. They never run `git diff`
against a changing working tree. Older uncaptured events explicitly say that
details were not recorded. See [historical file diffs](historical-file-diffs.md)
for capture identity, ownership, retention, failure states and verification.

## Verification

- `tests/test-chat-compact-tool-cards.mjs`: real render functions with a minimal DOM;
  duplicate lifecycle, parallel/out-of-order results, run-scoped IDs, legacy history,
  missing starts, completion settlement, tabs, output updates and literal diffs.
- `tests/test-codex-adapter.mjs`: identity across fresh adapter instances, patch
  preservation and completed searches.
- `tests/test-activity-browser.mjs`: optional Playwright check against actual CSS
  and renderers, desktop/mobile screenshots, tab interaction and page errors.
- The loader contract includes the new versioned activity asset.
