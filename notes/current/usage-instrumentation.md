# Basic usage observations

The authenticated workbench now records small actions in the instance-local
`CONFIG_DIR/usage-events/` ledger. Monitor → Usage analysis and
`GET /api/usage/analysis?days=7&sessionId=...` read the same records. This slice
adds no external analytics service, automatic semantic classifier or task-state
UI redesign. Human-attention presentation remains a separate product discussion.

## Product analysis

The default page answers four questions: who contributes, whether Feishu work
continues in Web, how execution and explicit questions progress, and which
published/attached artifacts receive deliberate workbench clicks. It does not
show raw action totals, tool traffic or recent event rows. Raw records and the
existing API diagnostics remain available for engineering investigation.

- People and active conversations require accepted human input, including
  question answers. Multi-turn exchange requires at least two ordinary inputs;
  question controls alone do not inflate it. Daily participation uses UTC+8.
- Paths match the same verified person and Session. Web answers count as
  continuation. Web input remains valid without an open record; opening and
  continuing are independent branches. Returning to the original Feishu
  conversation uses Web continuations as the denominator, not all entries.
- Executions use unique actual Run IDs linked to ordinary human inputs,
  including authoritative follow-up mappings. Question control requests are
  not extra Runs. Input-to-end time requires an observed original input; a
  follow-up to an older Run cannot invent its start. Ending is not satisfaction.
- Question waiting uses matching pending/answer records in the qualified
  interval. Timeouts and cancellations are not answers; ended Runs and expired
  deadlines do not appear as outstanding questions. Orphan terminal records do
  not create a zero-second waiting sample. Implicit waiting remains unclassified.
- Artifacts join hashed origins to registered asset IDs and count logical
  objects. New generation, website revision operations, attachment/publication
  and deliberate later opening remain separate. Automatic asset fetches never
  count as use. The opening cohort is this interval's provided objects; old or
  unlinked clicks cannot inflate it. Unsupported creation/edit counts are null.
- Aggregation uses the entire qualified event window before recent-event
  pagination. It begins after the latest known collection gap, avoiding pairs
  across missing data. Scan truncation or collection failures suppress rates
  and timings. Empty denominators and missing Web-opening samples are unknown;
  sample counts are always visible. No retention, adoption or satisfaction
  improvement is inferred from the short initial observation period.

## What is collected

| Source | Observed action | Counting boundary |
| --- | --- | --- |
| Web | page entered, Session opened, foreground/background/leave | Automatic repeat attachment does not create another open. Hidden pages do not count as opened. |
| Web | selected UI actions | Send/stop/new conversation/automation form/monitor navigation are intents, not successful operation receipts. |
| HTTP Request admission | input accepted | Actor and surface are set by authentication and the verified connector initiator. Native question answers count as inputs. Request retries count once. |
| Durable Request | request result | Native answers and follow-ups may settle on an existing Run; these are not extra completed Runs. |
| Durable runtime | Run state | Accepted/running/completed/failed/cancelled are execution observations, not business acceptance. |
| Normalized history | native question state | Pending, answered, timed out, unanswered, expired or cancelled; IDs/times retained, question and answer text excluded. |
| Normalized history | tool use / result | Run + tool call IDs link the records where supplied. An absent exit status stays unknown. No arguments or output collected. |
| Verified provider artifacts | generated image | Only actual provider-session artifacts are generation evidence. Arbitrary file writes, temporary images and attachment declarations do not prove generation. |
| File asset publication | registered deliverable | A hashed origin object links a verified local output to its asset ID. Registration can also concern an existing file. |
| Assistant reply | artifact attached | Types and counts are separate from generation; result-file messages retain the producing Run ID. |
| Static publishing | logical website published / updated | One slug is one website regardless of how many CSS/image files it contains. Updates retain object identity and are separate actions. |
| Web | content presented in foreground viewport | Presentation is deduplicated by visit, Session, history sequence and state. It does not prove reading or understanding. |
| Web | artifact click | Same-instance asset, image and publication links. Direct external visits are not measured. |
| File asset HTTP route | access requested | Thumbnail/inline requests may be automatic; this is not proof of a completed download. Explicit clicks have a separate event. |
| Durable source outbox | delivered / failed / unknown / cancelled receipt | Feishu delivery is not reading. The receipt is separate from content generation. |
| Session creation / delegation | created and parent-child link | A link proves delegation, not adoption or success. Forked historical events are not recounted. |

Automated requests retain actor=automation where the authoritative request
options identify them; agent and internal operations are separate from humans.
This first slice does not yet instrument every automation configuration change,
knowledge/Skill read, preview publishing mechanism or arbitrary file generation.
It does not automatically label messages as reminders, misunderstandings,
rework, satisfaction or human approval.

## Joining and interpreting the observations

Records include schema version, durable event ID, event and ingestion times,
surface/actor kind, and available Session/Request/Run/object/question/tool-call
IDs. Web visits and foreground presentation have their own IDs. Verified human
Person IDs and original Feishu conversation addresses are hashed, allowing the
same person's cross-surface actions to be joined without storing raw sender IDs,
conversation titles, addresses or text. File registration links hashed source
object IDs with deliverable asset IDs.

The first path summary groups the same Person and Session in chronological
order: first observed human input in Feishu → later Web open → later Web input
→ later input in the original Feishu conversation. The cohort begins within the
selected window; it does not establish the Session's historical starting surface
or where the business task finished. Different people and different threads
cannot stand in for returning to the original conversation.

## Storage and operational boundaries

The directory is mode 0700 and daily JSONL files are mode 0600. Records never
contain dialogue/answer text, raw file paths/names, command arguments, provider
outputs, credentials, IPs, fingerprints, complete URLs or arbitrary properties.
Client fields are whitelisted; client-supplied person/actor/surface attribution
and server-only event names cannot become authoritative records. The API is
behind normal workbench authentication; connector service credentials cannot
submit browser actions. Public snapshots do not collect workbench actions.

Collection queues are bounded and failures do not interrupt normal execution.
Recovered events older than collection start and already queued event IDs are
filtered before reserving capacity. Request bookkeeping does not re-enqueue
unchanged settled results or delivery receipts. Reads and CLI exit also await
events still waiting for collection metadata, not only pending file writes.
Browser batches retain IDs on retry; reader deduplication also survives server
restart and multiple appenders. The initial collection timestamp is persisted;
older event timestamps do not enter the baseline. Data is not retroactively
classified from old conversations. The query reads at most 30 days / 200,000
lines, returns at most 500 recent events and exposes scan/error/drop coverage.
A query cap or collection failure is an incomplete observation, not zero use.
Known incident intervals in collection metadata remain visible after restart;
reset process counters do not erase a previously confirmed observation gap.
There is no automatic deletion policy in this first slice.

Validation covers real isolated HTTP/native-question admission, cross-surface
identity and thread joining, retry/restart deduplication, authentication, privacy,
queue/storage failure, generated-image lifecycle and multi-file website revisions.
An optional real-browser check exercises the full workbench, all Monitor tabs,
mobile viewport, Session opening, foreground presentation and render deduplication.
