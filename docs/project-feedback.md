# Subproject feedback in Monitor

Monitor → Feedback and improvement shows feedback by the object being evaluated.
Open a subproject to inspect original wording, author, evaluated passage, source,
previous analysis and suggested change. Submit a usefulness signal, a specific
comment, an optional example and a material link. A record can also be referenced
by a supplement. These are collected records, not unresolved incident counts.

The instance operator can connect an existing review without copying private
comments into source control. `CONFIG_DIR/feedback-board.json` contains trusted
local paths:

```json
{
  "reviewFile": "/private/reviews/subproject-review.json",
  "legacyFile": "/private/feedback-records.json",
  "qianyanFile": "/private/reviews/qianyan-feedback-snapshot.json",
  "writeDir": "/private/web-feedback"
}
```

`reviewFile` supplies the manually reviewed `subprojects`, `themes` and
`classifications` from the existing review. A classification joins a stable
`source_record_id` to one `primary_subproject_id`, with one of
`assigned_feedback`, `unassigned_feedback`, `related_context`, or `paused_history`.
Each subproject has `subproject_id`, `name`, and `suggested_directions`. Theme
metadata explains the analysis; it does not assert implementation acceptance.
The classification is a projection of the original source, not a replacement
project registry. Missing sources remain visible as coverage gaps.

The legacy reader uses original source IDs. Mirrored website vote arrays are
joined by vote ID. The optional website source is explicitly a snapshot; its
review time is displayed. New source records without a reviewed classification
remain unassigned. A subproject absent from the sample says “not covered”; its
all-channel and unresolved counts are unknown. Context and paused records can be
read separately and do not contribute to active feedback counts.

`GET /api/project-feedback` returns subproject summaries. Pass `subproject=<id>`
for that subproject's records or one of the three non-assigned buckets. All reads
require authentication to this shared instance and are served private/no-store.
Provider identity objects, credentials and local evidence paths are not returned; stable original record IDs are retained for traceability.

`POST /api/project-feedback` accepts `client_id` (UUID), `subproject_id` (or empty
for unassigned), `usefulness` (`useful`, `not_useful`, or empty), `comment`,
`example`, `target_title`, `target_url` and `related_feedback_id`. Supply a signal
or a comment. Identity comes from the server's authenticated Person, never the
request body. Submissions are shared within the authenticated instance. A
same-origin JSON request or an authenticated bearer request is required.

Each new submission is an immutable original record under `writeDir` (default:
`CONFIG_DIR/project-feedback`), using private directory/file permissions and an
atomic no-clobber publication. Deduplication uses authenticated Person plus
client UUID; changed content with a reused UUID conflicts. The frontend retains
that UUID and draft after an uncertain result. Saved feedback begins as
`collected`, awaiting the existing Harness review. Saving does not trigger an AI
run, authorize a project change, or prove the change worked.

The existing feedback workflow should read this web directory at its next due
review, preserve stable original records, and write analysis into the existing
review/plan records. Updating a review pointer refreshes the monitor projection;
no automatic semantic classifier or separate review queue is introduced.

## Parent groups, dates and attention

Configure `metadataFile` in the same private board config. Its `groups` array
contains `{id, name, classification_status}`; `projects` is keyed by subproject
ID with optional `group_id`, `started_at`, `start_kind` (`project`, `registered`,
`rollout`), `start_source_url`, `observation_started_at`, `phase` (`existing`,
`planned`, `paused`), `usage_features` and `usage_scope`. This is a presentation
projection with source pointers, not a second business project registry. Missing
parents remain unconfirmed, and missing dates remain unknown. Never substitute
the first feedback, file timestamp or telemetry start for the project start.

The view groups subprojects under parents and orders attention by pending
analysis, feedback in the last 14 days, a sourced start within 14 days, observed
failed calls, and usage. New silent projects stay visible. Recent calls without
feedback suggest less frequent observation, not proven quality. A mature project
with no feedback in 14 days and no observed calls in a fully covered 30-day
window becomes an idle **candidate**. New feedback brings it forward immediately.
Unknown or short sampling cannot establish inactivity. Paused projects remain
paused. These states change display order only; the existing review schedule is
maintained independently.

## Feature invocation evidence

The board reuses `/api/usage`'s private event store and its deduplicated
`capability_state` aggregation. Narrow hooks cover `work context`
(`project_context`), `work route` (`work_routing`), task checklist publication
and `workboard update` (`response_progress`), and successful feedback saves
(`feedback`). CLI starts and settled receipts distinguish attempted calls,
completed entries and failures; a completed entry is not business acceptance.
Stable feedback record identity joins uncertain HTTP retries. Page views and
opening feedback details do not count as feature invocations. Direct human,
Agent and automation counts remain separate. Generic recording controls can be
mapped with an explicit partial scope; generic search or memory counts must not
be silently assigned to a business subproject.

New hook coverage has its own durable sampling start. Only observed intervals
after collection loss qualify; source gaps and uninstrumented features stay
unknown.
The board retains capability events only, scans at most one million raw lines,
and shares one read for five seconds between list/detail requests. A feedback
save invalidates that cache. Truncation remains unknown, never a zero-use claim.
`qianyanActivityFile` optionally reads the existing Qianyan collaboration
state as an aggregate: presentation counts are separate from expand, source
open, filter, copy, play and document-open operations. That source currently
retains cumulative buckets, so the board labels them cumulative and never
interprets a recent last operation as a 30-day total. It does not expose people,
comments, targets or authentication from that source, or use its cumulative
count alone to declare a project active or idle.

Verification: `npm run test:project-feedback` checks persistence, attribution,
concurrent deduplication, source joins, unknown coverage, validation and routes.
The optional synthetic browser gate in `tests/test-project-feedback-browser.mjs`
covers detail reading, supplements, submit/readback, reload, keyboard navigation,
phone layout, language switching and literal HTML in feedback.
