# Feishu project-linked context pilot

## Group reading levels and parent projects

`project-runtime.json` is the common source for group cards and the existing inspection planner.
Optional `projects[].parentId` expresses the existing project-index hierarchy (validated for missing parents and cycles).
It does not require a group on the parent project. A new group never implies a new project or a fabricated parent.
`groups[].readingLevel` is `focused`, `overview`, `paused`, or `excluded`; legacy registered groups retain focused behavior.
Paused project status takes precedence. Cards show the same project trail and level without changing response controls.

With an explicitly enabled `readingPolicy` (`autoDiscover`, `sourceRouteId`, `tenantKey`, `defaultLevel: overview`),
run `scripts/project-reading-sync.mjs --runtime <file> --profile <bot> --route <route> --tenant <tenant> --output <inventory>`
before the original scheduled inspection. Complete membership pagination precedes any atomic registry update.
New same-tenant groups default to overview; external/unknown-tenant/dissolved groups are excluded. Existing exclusions and
pauses survive discovery. Missing groups are not silently deleted; failures remain visible. A stale `.reading-lock` after
a killed process must be investigated before retrying; it is never treated as a successful inventory.
Optional `readingPolicy.excludeNamePrefixes` excludes explicitly named private/retired uses on discovery.

The inspection plan retains `sources` for focused analysis and Todo only. `overviewSources` is separate, collected with
`scripts/project-overview-collect.mjs --plan <plan> --profile <bot> --output <overview-dir>`: one page of up to 50 new roots
per group over 24 hours, no thread/resource/reaction expansion. Its manifest is explicitly `analysisEligible: false`.
Overflow is `sampled`, errors are `failed`; neither means a full history was read. Do not advance focused cursors or feed
overview content to project conclusions, report analysis, or Todo decisions. Reports show per-group methods and actual
coverage from both receipts, with paused/excluded reasons; new or failed coverage belongs in a short summary.
Discovery reuses the existing schedule, not a new periodic consumer. Registering a level is not proof of the next natural run.
`scripts/project-reading-directory.py --runtime <file> --doc <original-token> --profile <bot> --route <route> --output <evidence> --apply`
projects these same fields into existing directory table rows. It retains block IDs, original elements and comment anchors,
checks revisions before writing, verifies unchanged text and reports missing rows rather than inventing project ownership.
Without `--apply` it only prepares the changes. Unchanged configuration produces no document writes.
For the compact seven-column directory, pass `--boards <board-config> --native-groups <verified-native-index>`
to also maintain the existing board, project-brief and new-topic-injection columns and compact summary.
Columns are located by their headers, not by the last column. The notes keep their short reading-level
prefix; the synchronizer never re-adds a per-row hierarchy paragraph. Existing four-column directories
remain supported without coverage arguments. Unmapped native groups are pending, not delivered boards;
local readable briefs and runtime switches describe configuration, not a fresh client or real-topic test.
Directory injection requires `directoryEnabled: true` in addition to enabled project context; an absent switch is off.
Use the existing daily schedule. It should separately inspect current participation/topic exceptions and
the actual board transport; document maintenance does not enable groups, resume paused work, or publish cards.

## Native project entry

Operator prompt: “Enable `/project` for this existing project link. Register the
canonical memory file and exact heading, authorized resource links, and the IDs
and scopes of its existing schedules. Reuse those sources and the current Bot
callback connection. Verify scoped reads, controls, restart recovery, and actual
card delivery without changing production schedules for a test.”

The operator supplies one source packet: the existing project/chat pair, a
canonical memory path and exact Markdown heading, existing recurring schedule
IDs with short aliases and their actual shared scope, and authorized resource
links. Set `projectSurfacesPath` in the Connector config to an instance-local
registry:

```json
{
  "schema": 1,
  "projects": {
    "example-project": {
      "name": "Example project",
      "description": "Current project purpose",
      "memory": {
        "path": "/absolute/path/to/canonical-project-ledger.md",
        "heading": "## Example project",
        "label": "Project memory; maintained in the original ledger"
      },
      "tasks": [{
        "id": "sch_0123456789abcdef01234567",
        "alias": "daily",
        "scope": "Shared daily review; controls affect all projects it covers"
      }],
      "resources": [{ "name": "Original project discussion", "url": "https://example.com/source" }]
    }
  }
}
```

`/project` reads the registered sources and creates or updates one native card
in the current conversation. It does not create a new AI Session. Tabs show
project links, the exact memory section in pages, actual schedule state and
execution rules, and the durable audit of operations through this entry.
`/project memory`, `/project tasks`, and `/project audit` also work without
buttons. Optional `materials` register existing JSON source files with an
`alias`, `name`, absolute `path`, and a `fields` object mapping allowed top-level
field names to display labels. `/project material <alias> [page]` and card buttons
read those original audit/context fields inside Feishu; unregistered fields are
excluded. Read times and source versions are visible. Directory notifications
cover atomic file replacement; source changes update the original card. A
missing or ambiguous memory source is marked unavailable, never replaced with
an old copy. No source directory scan or new memory store is introduced.

Pause/resume buttons operate only on explicitly registered recurring schedules.
The callback must match the stored card, chat, source binding, and current
Connector access policy. Shared scope is shown beside every control. Before a
write the entry checks the current configuration version; scheduler counters
and execution timestamps are not configuration changes. Writes have durable
operation receipts, readback, and replay protection. An uncertain outcome stays
uncertain; restart inspects interrupted receipts without repeating a write.
Pause prevents future admissions and does not stop already running work.
This is not a transaction across independent clients modifying the scheduler.

`/project memory <correction>` continues the current Harness conversation with
the exact canonical source, registered heading, observed version, and the
human's original request. The Harness rechecks evidence and concurrent edits,
writes the original memory through its normal workflow, and replies with what
was actually adopted. Submission is not a successful write. The card then reads
that same source; it never maintains a synchronized editable copy. Arbitrary
task-rule edits similarly use the original conversation and existing schedule
tools. `/status`, `/model`, `/effort`, `/tier`, `/mute`, and `/unmute` retain their
existing conversation scope.

This entry is a bounded view over existing sources. It does not implement the
separate memory governance proposal, approve organizational consensus, discover
all possible tasks, or claim client click acceptance from API delivery alone.
The installed Bot must already have a configured `card.action.trigger`
subscription; enabling that subscription in Feishu's console is a human step
only if it is absent.

## Shared announcement context

Both chats in `projectLinks` use the discussion chat announcement as their shared
project background. New topics capture its current version, and existing topics
replace any pre-binding/local snapshot on their next input. The source is labelled
in the prompt. This does not copy or overwrite either Feishu announcement, change
reply destinations, or replace each topic’s own conversation history. Unbound
groups continue to read their own announcements.

## Linked conversation context

An instance may explicitly pair one discussion chat with one work chat in its
Feishu Connector config:

```json
{
  "projectLinks": [{
    "projectId": "example-project",
    "discussionChatId": "oc_discussion",
    "discussionChatName": "Example discussion group",
    "workChatId": "oc_work",
    "workChatName": "Example work group",
    "handoffCards": false
  }]
}
```

On a new message in the work chat, the Connector adds up to 20 recent messages
from the paired discussion chat to that message's source context. It uses only
allowed events already stored by this Connector, looks back at most
24 hours and at most 2 MiB each of the event log and project message stream,
and limits the text to about 6,000 characters. New human messages from either
bound chat are written to the project stream before their AI turns run. Confirmed
Bot text replies are written after delivery. This keeps recent project messages
available when unrelated chats fill the Connector event-log tail. Thread
replies are included when they arrived as Connector events;
each excerpt carries its original message ID and chat or thread link. A failed
context read does not block the current message.

Group Session transcripts label each new human message with its Feishu display
name and a stable, shortened member key. Recent same-chat history and linked
project excerpts use the same form when Feishu provides an identity. This
distinguishes members who share a display name and keeps conflicting statements
attributed to their speakers. If identity data is missing, the excerpt says so
instead of treating anonymous lines as one person. Older Session transcript
bodies are not rewritten; their original source metadata remains available for
read-only review.

The default direction is discussion to work. Work-chat messages are not
automatically posted to the larger discussion chat. The feature does not create
a semantic project ledger, send messages between chats, or change the scheduled
daily review's source whitelist. The imported text is a lead for the receiving Agent,
not a fresh instruction or an accepted project decision. Verify original
messages before relying on a decision or changing permissions or execution.

This is a time-bounded context pilot. It is not a full message archive or a
replacement for the project ledger. Messages absent from the Connector event
logs, attachments, older discussion, and later edits or recalls may require a
fresh source read.

### Optional two-way context pilot

For an explicitly approved pair, set `workToDiscussionContext: "full"` on its
`projectLinks` entry. The work-chat side continues to receive recent discussion
messages, and the discussion-chat side also receives recent human messages and
confirmed Bot text replies from the work chat. Work topics keep their own
Sessions; the other chat's excerpts appear only as attributed source context on
the next local turn. A cross-chat
message does not start a run, choose a reaction, or post a reply in the other
chat. Each side keeps its own reply destination.

This option exposes work-chat text to the discussion Session. Before enabling
it, check the actual membership of both chats and obtain explicit approval if
the discussion chat has members who cannot read the work chat. Group membership
can change, so the pilot operator must recheck it. The existing bounds still
apply: at most 20 messages from the other chat, within 24 hours and the
last 2 MiB of each log, with about 6,000 characters of context. It does
not provide a shared project summary, a per-Session unread cursor, or automatic
Session rollover. Those need separate acceptance before relying on this as
long-term project memory.

For a selected project link, `handoffCards: true` enables the discussion-group
handoff trial. The quick classifier nominates only a clear decision to start
work; the Connector then retrieves up to 100 messages (48,000 characters) from
the source chat or thread and checks the decision again before posting a card.
Mainline handoff lookup covers the preceding 24 hours without the ordinary
reply context's four-hour activity-gap cutoff; thread lookup remains bounded
by message and character limits. A card is then posted
under the source message. Clicking **Move to work group** creates one work-chat
topic and a Session bound to it, with the retrieved discussion and source link.
Clicking **Continue discussion** closes that proposal. Persistent records and
stable Feishu message UUIDs prevent repeated clicks or restarts from opening
duplicate topics. Unbound discussion-thread replies can nominate a handoff
without receiving reply-status reactions. On confirmation, current group
membership is checked again; the work-group members must all be in the
discussion group before source content is transferred. This requires
`card.action.trigger` callbacks enabled for the
app in the Feishu Developer Console. The proposal uses Card JSON 2.0 callback
buttons; the existing Connector WebSocket handles
those callbacks. If callbacks are not enabled, cards can display but buttons
will not reach the Connector. A detected candidate is only a suggestion: no
work topic is created until a human clicks the card.
Before offering a card and again at confirmation, the Connector verifies that
the configured work chat is an active topic chat. A stale link to a normal
group fails closed instead of offering a handoff to that group.

## Project group Agent cards and opening briefs

Ask the Agent: “For the groups already bound to projects in this instance, reuse
one main Session per group, pin its compact Agent card, show its main Session and project
skills, and maintain a shared project opening brief in Markdown and Feishu.”
The existing `MEMORY_DIR/project-runtime.json` group associations select the
scope. Register each group’s verified `chatName` and `tenantKey`; a project may
register `name`, `briefPath`, `briefUrl` and `skills` (`name`, `description`,
`skill`). `briefWorkflowPath` points to the instance’s existing event/review
maintenance workflow. These are instance pointers, not repository business data.

Enable `projectCards: true` on the intended Connector. On connection it resolves
each registered group’s existing main conversation, creates an idempotent Session
only when absent, and publishes the existing participation card. It sends no
synthetic human input and never starts work merely to create a Session. Explicit
response modes, paused projects, independent topic Sessions and model choices
remain intact. Card opt-outs remain effective until explicitly withdrawn by the
operator. Unbound groups are not inferred from titles.

Existing and new group configuration cards use the same compact presentation;
legacy `cardLayout` flags no longer select a full editor. The card retains the
available participation callbacks, actual main Session model/link, project
brief/time, up to three skills and authorized personal trial controls. The brief
link uses “项目名称｜项目共同认知·群内对话默认注入”. Work groups show their actual
per-message response policy even without a project binding. An unresolved `auto`
model is displayed as automatic selection, never a guessed model. Topic boards,
runtime/prompt editors and the refresh button are omitted from the group card;
existing configuration backends remain compatible.

An authorized style migration patches existing message IDs without creating
cards or changing participation. Adding controls to a card does not by itself
authorize creating one when no binding exists: check the original group card and
creation scope first. Publication suppression remains effective. Native Session
invalidations refresh the same card without a polling AI task.
Existing callbacks validate the card, actor and source before changes.

The normal prompt builder reads only registered projects’ opening briefs on each
accepted input, including resumed topics, with a hash and source pointer. Each
brief is bounded at 48 KiB; missing or oversized files are marked unavailable
rather than silently replaced with cached text. The detailed ledger remains a
pointer. Briefs are project background, not new task authorization; human
corrections take precedence over Agent interpretations without turning unresolved
conflicts into consensus. Document comments need an explicit project Session
binding because they do not carry a chat ID.

For maintenance, reuse the existing document-comment binding and the existing
04:00 project review workflow. Update local Markdown and the same Feishu document
in place; preserve manual edits, comments and anchors. Do not create a second
schedule or overwrite whole reviewed documents. API readback, native event tests,
actual client clicks, human comment response and the next naturally scheduled
review are separate acceptance evidence.

实例目录维护按 `project-runtime.json` 的项目绑定及显式 `directoryGroups` 计算话题目录注入覆盖。目录分组只补未绑定项目群的检索线索，不创建项目认知。汇总分别呈现目录注入和认知正文。维护脚本以 `--coverage` 独立更新“话题目录／项目认知／新话题注入”，将旧“实时看板”表头原位迁移为“话题目录”，保留块ID、样式及评论；不再把增强客户端映射状态混入注入验收。目录“已接入”指通道启用，空目录和群内尚未接入的人工讨论仍须明确披露。
