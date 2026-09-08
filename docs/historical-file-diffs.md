# Historical file diffs

File diffs belong to the conversation history, not the current checkout. Opening
a file activity never runs Git or reads that workspace file.

## Capture and ownership

- The detached Codex runner captures the completed file operation's native
  `FileChange` record. Its simplified stdout event only lists paths; the native
  record contains the actual patch. The patch is copied into RemoteLab's durable
  run spool before the event is projected. Large strings use existing spool
  artifacts, preserving the full value rather than a clipped preview.
- The capture reader consumes new log bytes on file completion only. A resumed
  run records the initial log offset before starting the provider, so it does not
  rescan old conversations. There is no watcher, periodic scan, Git snapshot,
  extra model call, or whole-file backup service.
- Native and stdout operation IDs differ. Association uses completion order
  within the current run/thread, checked against the entire path/kind set and
  completion status. Ambiguity fails closed; it must never match a later edit
  merely because the filename is the same. A short bounded retry handles a
  partially flushed log record. The native operation ID/source remain recorded.
- Normalization writes each full patch atomically to the existing session
  `bodies/evt_<sequence>_diff.txt`, then writes its event and advances history.
  The event carries only a body reference, byte size, and addition/deletion counts.
  The history owns this copy independently of provider logs and run artifacts.

## Retention and cost

Diff bodies have **no age-based expiry**. Context compaction and session archival
do not remove them. Later workspace edits, commits, deletion, provider-log
cleanup, or service restarts do not change the recorded patch. Forked sessions
copy hydrated bodies into their own history; they do not depend on the parent.

They follow ordinary history ownership: explicitly clearing/deleting that
history may remove its bodies. Backup/restore must include the entire
`chat-history/` tree, including `bodies/`, not only event JSON. This is durable
local storage, not protection against disk loss without backups.

The ordinary timeline and expanded thinking block defer patch bodies. Only
opening a particular file requests its existing authenticated event-body URL.
The open DOM retains the result; full diffs do not accumulate in the server or
browser's global text caches. There is no new public URL or filesystem-read API.

## Honest boundaries

- This collector supports Codex's native `FileChange` completion records. Other
  runtimes can use the same storage by emitting a normalized `file_change.diff`;
  generic shell edits are not silently attributed to a tool call.
- Already supplied runtime patches are preserved. Add/delete contents can form
  a patch without reading the workspace. Binary or absent detail is stated
  explicitly. An empty patch is distinct from an uncaptured one.
- A failed operation's patch is labeled as an **attempt**, not proof that the
  change was applied. A body fetch failure offers retry and is not presented as
  a failed file modification.
- Code is rendered literally with text nodes, without interpreting markup or
  stripping conversation-only `<private>` blocks from source code.
- Old events are not automatically rewritten. A read-only replay recovered all
  10 file events in one real historical run, showing that some native logs can
  support an explicit future backfill. Missing logs cannot be reconstructed
  accurately from today's checkout. Runners already executing old code need a
  new run to use the capture path.

## Verification

`npm test` includes `tests/test-file-change-durability.mjs`: repeated edits,
failed operations, partial records, ambiguity rejection, large spool bodies,
actual sidecar execution with a deterministic file-editing runtime, independent
history ownership after native log/run deletion, later workspace edits,
compaction, fresh module reload, fork independence, and missing-body handling.

The optional `tests/test-activity-browser.mjs` Chromium gate also checks no patch
requests for closed files, keyboard opening, retry, literal code, reuse on
reopen, and desktop/mobile layout. Native chat acceptance uses the existing
MOCK conversation rather than a separate showcase page.
