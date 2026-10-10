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

Verification: `npm run test:project-feedback` checks persistence, attribution,
concurrent deduplication, source joins, unknown coverage, validation and routes.
The optional synthetic browser gate in `tests/test-project-feedback-browser.mjs`
covers detail reading, supplements, submit/readback, reload, keyboard navigation,
phone layout, language switching and literal HTML in feedback.
