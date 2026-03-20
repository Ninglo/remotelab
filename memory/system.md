# System-Level Memory — RemoteLab

Universal learnings and patterns that apply to all RemoteLab deployments, regardless of who runs it or on which machine. This file lives in the code repo and is shared with all users.

## What Belongs Here

- Cross-platform gotchas (macOS vs Linux differences)
- Common failure patterns and their root causes
- Effective prompt patterns and anti-patterns
- Best practices for tool orchestration (Claude Code, Codex, etc.)
- Architecture insights that reduce future debugging time

## Learnings

### Feishu Bot Outbound Permission Trap (2026-03-11)
- A Feishu self-built app can successfully receive `im.message.receive_v1` over persistent connection while still failing every outbound IM send.
- The tell is Feishu API error `99991672` on `im.v1.message.create`, which means the app is missing an explicit outbound IM scope even if the basic bot setup looks complete.
- When this happens, keep the connector code unchanged and ask the operator to enable one of the exact scopes Feishu names in the error, such as `im:message:send`, `im:message`, or `im:message:send_as_bot`, then replay the latest stored message.

### Feishu Group Names Need Separate Tracking (2026-03-11)
- The inbound message event `im.message.receive_v1` includes `chat_id` and `chat_type` but does not include a group name field.
- If a bot needs human-friendly group names without calling the chat-detail API on every message, cache them from chat metadata signals such as `im.chat.member.bot.added_v1` and `im.chat.updated_v1`, which carry `name` and `i18n_names`.
- If the bot starts after it was already added to a group and no metadata-change event has fired yet, an initial one-time chat-detail lookup is still needed to seed the cache.

### Feishu @ Mentions Need Token Translation (2026-03-11)
- In `im.message.receive_v1`, group-message text can contain placeholder tokens like `@_user_1` while the actual mentioned-user identity arrives separately in `message.mentions`.
- If the connector forwards only the raw text preview, the model cannot tell who was mentioned; if outbound replies send those tokens back as plain text, Feishu shows the literal token instead of a real `@` mention.
- Fix both directions together: render inbound prompt text with a token→name map from `message.mentions`, and translate reply tokens back into Feishu mention markup before calling `im.v1.message.create`.

### Feishu Self-Built App Rollout Is Tenant-Scoped (2026-03-11)
- A Feishu self-built app is a good fast path for local or same-tenant validation, but it is the wrong mental model for cross-tenant distribution.
- If coworkers cannot search the bot or add it to groups, first check app availability scope, current version publish/apply status, and tenant policy before touching connector code.
- For practical internal rollout, prefer a real team tenant over a purely personal self-test tenant; for external-tenant usage, move to a marketplace / distributable app flow.

### Long-Lived Connectors Must Re-Read Owner Tokens On Auth Refresh (2026-03-13)
- A connector can look healthy for hours while reusing a cached owner session cookie, then suddenly start failing every upstream request after that cookie expires or the owner rotates `auth.json`.
- If forced re-auth keeps reusing the connector's in-memory owner token, `/?token=...` can redirect to `/login` without a new `Set-Cookie`, and the connector surfaces misleading downstream errors even though RemoteLab itself is up.
- On forced auth refresh, clear both the cached cookie and the cached owner token, reread the current owner token from disk, then log in again before retrying the API request.
- Keep a regression test that starts from a stale in-memory token and verifies that refresh re-reads the latest token instead of trusting cached state.

### Memory Bootstrap Hygiene (2026-03-06)
- Fresh or partially initialized RemoteLab setups may be missing `~/.remotelab/memory/skills.md`.
- If session startup expects that file, create a minimal placeholder index instead of treating the absence as a hard failure.

### Context Continuity Across Restarts (2026-03-06)
- Claude Code's `--resume <session_id>` flag is the ONLY mechanism for conversation continuity. Without it, every spawn starts a completely fresh session regardless of what the UI shows.
- Any in-memory state critical for continuity (session IDs, thread IDs) MUST be persisted to disk. In-memory Maps are wiped on process restart.
- The UI chat history (stored in JSON files) and the AI's actual context (controlled by `--resume`) are completely independent. Users will see old messages but the AI won't remember them — a confusing UX failure mode.
- Fix: persist `claudeSessionId`/`codexThreadId` in the session metadata JSON, rehydrate into memory when the session is first used after restart.
- **Rehydration ordering trap**: WebSocket `subscribe`/`attach` creates a bare `live` entry in the in-memory Map BEFORE `sendMessage` runs. If rehydration is gated on `!live`, it gets skipped. Rehydration must check the live entry's fields, not its existence.

### Testing Strategy for Self-Hosted Services (2026-03-06)
- Never restart the server you're running on to test restart-survival features. Spin up a separate instance on a different port (e.g., 7694) and run the full test cycle there.
- Use node WebSocket client for API testing — match the actual protocol (`action` field, attach-before-send flow).

### Similar UI Totals Often Have Separate Code Paths (2026-03-11)
- In RemoteLab, session row counts, folder counts, archive counts, and app-filter totals can look like one product concept while still coming from different frontend functions.
- When a screenshot reports a "count bug", first identify the exact UI surface and trace that specific DOM/data path; fixing an adjacent counter can create false confidence while the real bug remains.
- For the session sidebar specifically, per-session row counts live in `static/chat/ui.js`, while the app-filter totals are computed separately in `static/chat/bootstrap.js`.

### Template-Literal Prompt Edits Can Break Server Boot (2026-03-11)
- `chat/system-prompt.mjs` builds a large template literal, so inserting raw backticks inside the embedded prompt text creates a syntax error that prevents `chat-server.mjs` from starting.
- After touching server-loaded modules or large inline prompt/template strings, run `node --check` before restart, then verify both the listener and a real HTTP endpoint; do not rely only on a helper script printing "restarted".

### Project Path Persistence (2026-03-06)
- When a user has already confirmed a repo path for an active task, persist that path immediately into user-level memory or a task note.
- On later turns, check memory before doing broad filesystem searches; repeated rediscovery wastes time and breaks continuity.

### Tool Selection State Must Be Split (2026-03-06)
- If the UI supports switching tools mid-session (e.g. Claude → Codex), the session metadata on disk MUST be updated when the switch happens. Otherwise reload/reattach paths snap the selector back to the stale `session.tool`.
- The active session tool and the user's default tool preference are different states. Reusing one variable for both causes "it keeps forgetting my default" bugs whenever the user opens an older session.

### Codex Home Directory Trust Check (2026-03-06)
- `codex exec` can hard-fail with `Not inside a trusted directory and --skip-git-repo-check was not specified.` when `cwd` is the user's home directory, even if approvals/sandbox are already bypassed.
- In RemoteLab, this presents as a "silent" or "no response" Codex session because the process exits before emitting JSON events; Claude does not have this constraint, so the mismatch looks path-specific.
- If the product intentionally launches agents from `~` or other non-repo roots, pass `--skip-git-repo-check` in the Codex adapter (or explicitly trust that directory in Codex config).

### Codex Reply-Style Steering Is Most Reliable Via `developer_instructions` (2026-03-18)
- In current ChatGPT-authenticated `codex exec` runs, Codex's official `developer_instructions` config path reliably changes reply style, including suppressing default heading/list-heavy answers in favor of connected prose.
- On the same setup, the documented top-level `instructions` and `model_instructions_file` controls did not materially change trivial `codex exec` outputs in smoke tests, even though the open-source code and schema suggest they should affect base instructions.
- For manager-controlled style shaping in wrappers like RemoteLab, prefer passing `-c developer_instructions=...` on each Codex invocation over relying on prompt prefixes alone.
- RemoteLab now benefits from a lightweight default Codex developer instruction that frames Codex as a runtime under manager-owned workflow/style policy, while still allowing explicit per-run override or opt-out for niche cases.
- To keep manager policy canonical, RemoteLab-managed Codex runs should prefer a dedicated `CODEX_HOME` that shares auth but omits user-global `config.toml` personality/style settings and other local Codex-specific drift.

### KYC / Account Registration Requests (2026-03-06)
- If a user asks for a "public address" or advice on what address/location to enter for account opening, treat it as potential misrepresentation/compliance evasion.
- Do not help source placeholder/fake addresses or craft deceptive explanations.
- Safe fallback: explain legitimate reasons residence and phone region can differ, suggest truthful disclosure, and provide a concise compliance-safe explanation template.

### Provider Abstractions Must Own Runtime + Models (2026-03-06)
- If command discovery, model catalogs, reasoning controls, and runtime spawning live in separate hardcoded switches, "custom tool" support becomes fake: the dropdown works, but model selection and execution do not.
- RemoteLab should treat a provider as the single source of truth for command availability, model catalog, reasoning schema, runtime adapter, and resume key.
- Use the same provider contract for two extension paths: local static JSON for hardcoded catalogs, and JS modules for dynamic probing / PR-worthy integrations.

### Provider Extensibility Works Best as Preset + Form + Code (2026-03-06)
- Pure code-only plugin systems discourage casual contributions; pure GUI forms cannot express custom parsers or dynamic probing.
- A good provider ecosystem has three layers: builtin presets, GUI-authored local JSON providers, and advanced JS providers.
- To keep the GUI itself extensible, runtime families should expose a declarative authoring schema that the frontend renders, instead of hardcoding separate forms for each provider.
- As a lightweight bridge, adding a synthetic `+ Add more...` action to the existing tool picker is enough to teach extensibility early, without waiting for a full provider-management page.
- Background one-shot model calls (for example session auto-naming or sidebar summarization) must reuse the triggering turn's provider/model/reasoning config. Hardcoding those paths to Claude creates hidden availability bugs on Codex-only installs.
- Claude Code and Codex do NOT emit the same raw JSON protocol, but both can be normalized into the same internal event stream. The parser boundary should therefore be runtime-family-specific, while the UI/session layer consumes the normalized events.

### Private CLI Providers Need A Wrapper Escape Hatch (2026-03-12)
- A local JSON/simple provider that stores only a single `command` cannot directly express CLI integrations that require a fixed subcommand or bootstrap argv, such as `mc --code`.
- The lowest-friction private-integration path is a tiny local wrapper executable that normalizes the real invocation into one stable command, then bind that wrapper to an existing runtime family in local provider/tool config.
- Treat "binary resolves on PATH" and "provider auth/session is actually ready" as separate checks. A private CLI can look available to the picker while still failing every run until its local login/token state exists.
- Some private Claude-flavored CLIs are not truly drop-in compatible with RemoteLab's default multiline preamble. `mc --code` accepted short single-line prompts but misbehaved on multiline prompts, emitted only raw stderr/stdout, and left RemoteLab with zero normalized events.
- Local provider config therefore needs lightweight prompt-shaping controls, not just `command`/`runtimeFamily`. A practical minimum is `promptMode: "bare-user"` plus `flattenPrompt: true` so a brittle private CLI can receive only the user text in a single line.
- When a structured runtime exits with code 0 but produces zero normalized events, surface the raw output as a run failure instead of silently marking it completed. That makes provider-contract breaks debuggable immediately.

### Cross-Provider Session Continuity Needs A History Handoff (2026-03-06)
- Provider-native resume IDs (`claudeSessionId`, `codexThreadId`) preserve context only within the same runtime family; clearing them on tool switch without another handoff silently drops the session's prior context.
- Once providers already normalize their raw output into a shared event history, the first turn of any fresh provider thread should inject a transcript reconstructed from that normalized history.
- Build the handoff from user/assistant messages plus salient tool calls/results/file changes, not raw provider JSON and not prior reasoning traces.
- Exclude the just-sent user message from the reconstructed transcript, or the new provider sees that message twice.

### Private Cross-Device Context Needs Its Own Layer (2026-03-06)
- A simple split between repo-shared memory and machine-local memory breaks down when the same user runs RemoteLab on multiple computers.
- Keep universal prompt/memory in the repo, keep machine facts local, and maintain a separate private portable layer for user-specific but cross-device principles.
- The portable layer should contain stable collaboration preferences and execution principles, not local paths, ports, logs, launchd/systemd details, or secrets.
- Reliable bootstrap flow: install RemoteLab first, then import the portable layer into `~/.remotelab/memory/global.md` as a synced block, and let each machine maintain its own local notes around that block.
- For ongoing multi-machine use, sync the portable layer through its own git repo; do not sync the whole machine-memory directory.
- A public repo is only appropriate if the portable layer is intentionally curated as publishable and is audited for machine-local or secret-like content before push.
- If the sync repo is private, include bootstrap/helper scripts in the repo as well so a newly provisioned machine can clone once and self-bootstrap without relying on an out-of-band bundle.
- Bootstrap flows for active development should pin an explicit source branch when the desired code is ahead of the repo's default branch; otherwise fresh machines silently install stale code.
- When a user says another machine should "just use the latest updates," verify whether those commits only live on a feature branch; either fast-forward the default branch or communicate the exact branch to pull.
- Any constraint that must apply from the very first assistant turn (for example output language or branch selection) must be stated in the bootstrap handoff prompt itself, not only in memory that gets imported later.

### Browser-Only Frontend Validation Without A Test Harness (2026-03-06)
- For `static/*.js` browser IIFEs that hide internal functions, a low-friction regression check is: load the real source into a temporary `jsdom`, patch the final `})();` in-memory to expose the target functions, and exercise them against a minimal DOM fixture.
- This validates the actual shipped file and DOM mutations without adding permanent test dependencies or modifying the repo.

### `nettop` Byte Logging Requires CSV Mode (2026-03-06)
- On macOS, `nettop -P -x -k bytes_in,bytes_out` does NOT give a bytes-only table; it can still emit the default columns, which makes any parser silently wrong.
- For machine-readable per-process byte counters, use `nettop -P -x -L 1 -J bytes_in,bytes_out -n` and parse the CSV output.
- If you need interval deltas instead of cumulative counters, add `-d` and capture the second sample from `-L 2`.

### End-to-End AI Workflows Usually Break At Input Sprawl, Not Model Quality (2026-03-06)
- Once an AI workflow already runs end-to-end, the next bottleneck is often scattered inputs across files, env vars, chat instructions, and operator memory rather than raw model capability.
- Before adding UI or broader feature surface, unify the workflow into a single job contract / manifest so prompts, CLIs, artifacts, and review all read the same source of truth.
- A good smell test: if each run still requires re-explaining goals, policy, or runtime assumptions in chat, the workflow is not productized yet.

### Auto-Renamed Titles Need An Explicit Pending Flag (2026-03-06)
- If a session title can pass through multiple automatic states (for example default placeholder → first-message draft → model-generated summary title), do not key rename eligibility off the visible name alone.
- Persist an explicit boolean like `autoRenamePending`; otherwise a temporary draft title blocks the later AI rename, and a late AI callback can overwrite a user's manual rename.
- The rename callback itself should re-check that pending flag at execution time, not just when the background summary job started.

### Active Session Restore Should Share One Deep-Link Contract (2026-03-06)
- Refresh restore, sidebar tab restore, and notification-open behavior should not each pick their own session separately; drive all three from the same `session`/`tab` deep-link contract plus one persisted local fallback.
- Good precedence is: explicit notification/URL target first, then last locally active session, then most recently updated session.
- Push notifications should carry the target session URL in their payload, and existing app windows should receive an in-page message to switch sessions without a forced reload. Fresh windows can fall back to `openWindow(url)`.
- To make "latest session" meaningful, sort by real session activity rather than every metadata write. Archive/unarchive should not bump the active-list recency signal; keep archive ordering on its own `archivedAt` path.

### Open Local Config Should Fail Per Record, Not Per File (2026-03-06)
- Once provider/tool extensibility relies on user-editable local JSON, a single bad record must be skipped with a clear log instead of breaking the entire picker/API response.
- Treat malformed config files and unsupported provider fields as operator mistakes to isolate, not reasons to take down unrelated valid tools.
- If quick-add stays lightweight, document its compatibility boundary explicitly in the UI: family-compatible CLIs can be saved live; anything with custom flag semantics should take the advanced path.

### Owner / Visitor Splits Must Be Enforced Per Route (2026-03-06)
- In RemoteLab, "authenticated" is not a sufficient authorization boundary once share-link visitors exist; a visitor session cookie is still a valid authenticated session.
- Every HTTP route and WebSocket action must explicitly decide whether it is owner-only, visitor-scoped, or public. Relying on UI hiding or a generic `requireAuth` check lets share-link visitors reach owner surfaces.
- High-risk examples are session CRUD/listing, filesystem browse/autocomplete, global settings/sidebar state, and push-subscription endpoints; those leak host metadata or allow state changes even when visitors cannot fully attach to owner sessions over WebSocket.
- A safe regression pattern is to boot the server under a temporary `HOME` with `SECURE_COOKIES=0` on an isolated port, create both owner and visitor cookies, and verify each route class with `curl`/WebSocket probes without touching the live config.

### Share-Link Visitor State Must Come From Auth, Not URL (2026-03-06)
- A one-time `/?visitor=1` redirect is only a bootstrap hint. After the frontend cleans that query param, refreshes still carry the visitor cookie but no longer carry the URL marker.
- If the UI only checks the URL to decide visitor mode, a refresh silently falls back into owner-style initialization and immediately calls owner-only APIs.
- Reliable pattern: derive mode from authenticated role before any owner-only requests, but do not force that through a blocking extra round-trip. If the HTML render already knows the auth session, inline a small bootstrap payload (for example owner vs visitor plus visitor session IDs) and let the frontend use `/api/auth/me` only as a fallback or non-HTML API surface.

### Hidden Markdown Blocks Work Best As Parser Extensions (2026-03-06)
- For `marked`, custom block + inline extensions are a clean way to consume tags like `<private>...</private>` and `<hide>...</hide>` so the UI hides them while the raw message text stays intact for history and model context.
- After rendering, skip empty assistant bubbles; otherwise a response that only contains hidden blocks still leaves blank UI chrome behind.

### External Reply Connectors Should Treat Empty Output As Silence (2026-03-11)
- When a connector asks the model to output the exact outbound reply body, an empty assistant message should mean "send nothing", not "send a fallback apology".
- Mark the inbound item as handled with a silent/no-reply status and log the reason; otherwise connector-level fallbacks override deliberate quiet-mode behavior and make response suppression unreliable.

### External Reply Connectors Need Shared Reply Selection (2026-03-11)
- Do not blindly publish the raw latest assistant `message` event for a run; provider adapters can append assistant-side artifacts after the real reply, such as Codex `todo_list` checklists.
- Keep that selection logic out of the core chat-history/domain primitives. A better boundary is: chat core exposes raw normalized events, while connectors or other business-facing layers apply a shared helper library to choose the outbound reply they want.
- A practical default rule is: skip known artifact kinds such as `todo_list`, and if the trailing assistant text is only a checklist block, fall back to the nearest earlier substantive assistant reply from the same run.

### Backend Connectors Cannot Inherit UI Runtime From LocalStorage (2026-03-12)
- If an external connector should reuse the operator's current tool/model/reasoning choice, the browser must sync that selection to server-readable state; backend workers cannot see `localStorage`.
- Treat the synced selection as the live runtime preference for connector-triggered sessions, and let connector-specific pinned overrides win only when they are explicitly configured.

### Composer Drafts Must Exclude In-Flight Sends (2026-03-17)
- Durable draft storage should represent only editable local composer text, not an outbound request that is already being sent.
- When a send starts, clear the persisted draft immediately and keep the temporary "sending" copy only in memory for the active page.
- Otherwise a reload can resurrect text that the server already accepted, making the composer look stuck in a duplicate sending state.

### Composer Sending Must Yield To Canonical Session Activity (2026-03-17)
- Treat the local composer `sending` state as a very short pre-ack phase only, not a peer to the backend session activity model.
- Once the backend session activity shows the message has been accepted into real work — for example a new run starts, the run phase reaches `accepted`, or the follow-up queue count increases — clear the local sending lock immediately.
- Otherwise the UI can show contradictory states like `running` in the header while the composer still looks frozen in `sending`.

### Connector App Scopes Should Be Real Apps, Not Chat Aliases (2026-03-12)
- If an integration like Email creates sessions with its own `appId`, ship a real built-in app entry for that scope so the UI can present it consistently instead of feeling like an unnamed Chat fallback.
- Mark connector built-ins as non-template apps, and hide them from the sidebar when they have zero sessions; otherwise they clutter owner-facing app/template controls while still failing to model the connector cleanly.

### Domain Workflow Apps Should Stay User-Created (2026-03-14)
- Reserve built-in apps for product-structural roles such as the owner chat surface, app-creation helpers, or connector scopes that need a stable first-class identity in the UI.
- Do not hardcode niche business workflows like video cutting as shipped built-ins; model them as normal shareable apps so they remain optional, editable, and unspecial in app ordering and product copy.

### Post-Run Integrations Should Live Outside `chat/` (2026-03-11)
- Business-specific side effects triggered by finished runs, such as outbound email delivery, should not live under the core `chat/` domain modules even when the chat server invokes them.
- A cleaner split is: `chat/` owns sessions, runs, and event history; integration modules under `lib/` or connector-specific areas consume those primitives and perform provider-specific delivery work.

### Connector HTTP Sends Must Respect Proxy Reality (2026-03-19)
- Do not assume Node's built-in `fetch` will successfully inherit the operator's shell proxy setup on every machine; in real local-first deployments it can fail with `fetch failed` / `UND_ERR_CONNECT_TIMEOUT` while `curl` to the same URL succeeds.
- For connector-owned outbound delivery paths, prefer a transport that explicitly respects proxy environment variables, or keep a proxy-aware `curl` fallback so completion-side effects do not silently die after the model already produced a valid reply.
- Treat this as delivery-layer logic, not model/output selection logic: if the final assistant reply exists in history but the user never receives it, inspect the transport first.

### Deferred Event Bodies Must Stay User-Triggered (2026-03-10)
- If thinking/tool bodies are deferred behind `GET /api/sessions/:sessionId/events/:seq/body`, the frontend should only fetch them when the user explicitly expands the corresponding UI block.
- Do not auto-hydrate deferred bodies just because a tool exited non-zero or because the session initially rendered; that silently defeats the lazy-loading contract and creates request bursts on session open.
- For RemoteLab chat history, prefer the simple model: load the full normalized event list in one `GET /api/sessions/:sessionId/events`, keep heavy bodies deferred, and ignore pagination-style query params unless the product truly needs them.

### Private Skill Knowledge Stays Out Of Shared Memory (2026-03-06)
- Repo-shared system memory must not store operational notes for private or org-specific skills/integrations, even if the pattern feels broadly useful inside one company's environment.
- Put that knowledge in the skill's own docs when the skill is private/local, or in user-level memory on the relevant machine if it is an operator-specific workaround.
- Reserve shared system memory for truths that still help a generic RemoteLab deployment with no access to the private skill at all.

### Always-On Memory Should Be Tiny And Ranked (2026-03-06)
- If hard rules, user preferences, long memory notes, skill catalogs, and operator guidance are all injected at session start, important constraints lose salience and the model falls back to generic heuristics.
- Split context into tiers: a tiny always-on contract for non-negotiables, a short session note for the active task, a lightweight capability index, and on-demand retrieval for detailed memory/skill docs.
- Prefer promoting only durable constraints into always-on context; demote examples, edge cases, long explanations, and rare workflows into indexed reference material.

### Task Scope Must Gate Memory Retrieval (2026-03-06)
- Do not preload unrelated project/task memory for generic conversations just because those files exist on disk.
- Memory retrieval should follow a gated flow: bootstrap contract first, then identify/confirm the current task scope, then load only the matching task notes, skills, and domain docs.
- Project-specific notes are retrieval candidates, not mandatory startup context. For example, an `intelligent-app` task note should stay out of a general conversation unless the user clearly moves into that task.
- A startup rule like "read all memory files at the start of every session" is an architectural mismatch if the product goal is focus and bounded context; it turns retrieval into unconditional preload.

### Memory Writeback Must Be Sparse And Pruned (2026-03-06)

### HTTP Reconciliation Must Not Spam Realtime (2026-03-09)
- If HTTP reads reconcile detached-runner spool files into canonical history, do not emit WebSocket/SSE invalidations on every read path by default.
- Only broadcast when the read actually materialized new durable state (new events, new status, terminal transition). Otherwise transport hints can create self-amplifying refresh loops.
- A stronger steady-state pattern is: HTTP remains the source of truth, hot GET routes support ETag / `If-None-Match` revalidation, and WebSocket is reduced to a push-only invalidation hint.
- In that model, correctness still does not depend on socket-only payloads, but convergence without realtime comes from manual refresh or the next HTTP interaction rather than a hidden polling loop.

### PWA Frontend Freshness Needs Dynamic Asset Fingerprints (2026-03-12)
- Reading HTML templates from disk on every request is not enough if the page injects a build or asset version that was frozen when the server process started.
- For RemoteLab's no-build-step frontend, compute a page asset fingerprint from the latest mtime under `templates/` and `static/`, and inject that per request into HTML so script, icon, manifest, and service-worker URLs change as soon as frontend files change.
- When the app already keeps a WebSocket open, prefer sending the current page build info on socket connect and rebroadcasting it on frontend file changes; existing pages can then reload from push without adding extra focus/visibility polling.
- Keep versioned static asset URLs (`?v=` or hashed filenames) on long-lived immutable caching, and let only non-versioned assets or `sw.js` stay on revalidation/no-store policies.

### Detached Run State Must Be Read Fresh Across Processes (2026-03-10)
- `status.json` and `result.json` are shared mutable state between the chat-server control plane and detached runner sidecars, so process-local caches are not authoritative.
- If `getRun()` serves a cached copy, the UI can stay stuck on `running` or `accepted` after the tool already finished, because spool normalization writes can overwrite fresher terminal state from another process.
- The same cache bug breaks Stop: a sidecar polling cached run state never sees `cancelRequested: true`, so `SIGTERM` is never sent to the tool process.
- Read mutable run state from disk on every reconciliation / cancel poll, and merge status updates against the latest on-disk record so normalization metadata cannot regress terminal fields.
- Reconciliation should also treat a present `result.json` as terminal evidence if `status.json` is still non-terminal; that state can happen if the sidecar writes the result file and then dies or is interrupted before its final status write lands.
- When backfilling terminal state from `result.json`, prefer `result.cancelled` over a later `cancelRequested` flag. A user can press Stop after a successful run already completed, and that late cancel request must not rewrite a completed run into `cancelled`.
- If a session record still carries `activeRunId`, force a detached-run sync on session reads even when the cached run already looks terminal/finalized; otherwise APIs like session fork can clone a half-reconciled history before the terminal spool flush has materialized into durable session state.
- Reflection is valuable, but memory writes should be rare and selective. Persist only durable lessons with clear expected reuse.
- Prefer editing, merging, or deleting existing memory instead of appending near-duplicate notes.
- Memory hygiene should happen on a light cadence: daily during intense debugging or weekly otherwise.
- Archive or trim stale task notes once they stop improving future execution.

### Boot Memory Should Stay Pointer-Sized (2026-03-06)
- In RemoteLab, the built-in boot prompt should stay a small pointer/index that tells the agent which memory files exist; do not inline full memory documents there.
- Default context bloat usually comes from the agent explicitly reading large memory files and from accumulated chat/tool history, not from `buildSystemContext()` itself.
- Practical rule: keep bootstrap memory tiny, split large notes into topical files, and read deep context on demand instead of every session.

### Scope Routers Should Cover Non-Repo Domains Too (2026-03-09)
- A routing file like `projects.md` fails if it models only code repositories; recurring scopes such as video production, recruiting, or writing then get pushed back into generic global memory.
- Keep the router broad enough to cover both repos and non-repo task families, with trigger phrases and the next file, skill, or path to open.
- The filename can stay `projects.md` for compatibility, but its job is scope routing rather than a strict repo catalog.

### Existing RemoteLab Push State Can Power One-Off Reminders (2026-03-06)
- If a deployment already has active web-push subscriptions, you can send ad hoc reminders without touching app code by reading `~/.config/remotelab/vapid-keys.json` and `~/.config/remotelab/push-subscriptions.json` from a local script and using the repo's `web-push` dependency directly.
- This is useful for operator-scheduled reminders or out-of-band alerts, but it still depends on the host machine being awake and online at send time; pair it with a local fallback notification and, when appropriate, temporary `caffeinate`.

### Public Snapshot Shares Should Be Static + Sandboxed (2026-03-06)
- For one-link public transcript sharing, generate an immutable snapshot from the current session history instead of attaching visitors to any live session or auth state.
- Serve the snapshot as its own read-only page with embedded snapshot data, not the normal chat app bootstrap, so there is no sidebar, websocket, or send path to accidentally expose.
- Tighten the share page boundary with `connect-src 'none'`, `Referrer-Policy: no-referrer`, and `X-Robots-Tag: noindex, nofollow, noarchive`.
- When rendering shared markdown, strip raw HTML and same-origin relative links so a snapshot cannot be used as a pivot into other app routes.

### Restart-Safe Autonomy Should Be Session-Centric (2026-03-06)
- For proactive agents, the durable unit should be the session/run/trigger log plus provider-native resume IDs, not the current OS child process or WebSocket connection.
- Long-lived background processes are optional. Many "active agent" behaviors are better modeled as re-triggerable one-shot runs that resume from persisted provider state when a trigger fires.
- A clean split is: control plane for auth/API/WebSocket/event replay, runtime manager for session leases/spawn-resume-cancel/watchers, and one durable store shared by both.
- Optimize product promises around logical continuity (no lost work, replayable events, resumable runs) rather than transport continuity (the socket never dropped), because restarts and mobile-network churn make transport loss normal.

### External Connectors Should Prefer HTTP-Truth + Thin Invalidation Over Broker-Owned Worker State (2026-03-12)
- If a connector bridge server starts owning per-client inflight leases, busy flags, and retry semantics, connector availability leaks into the server's correctness model and failure analysis becomes much harder.
- A cleaner long-term shape is: persist canonical session/run/event history in the control plane, let connectors authenticate and fetch the session list / event deltas over HTTP, and keep WebSocket or SSE as a push-only invalidation hint rather than the authoritative delivery channel.
- The right concurrency boundary is usually keyed: same external thread or same session stays serialized, while different sessions can progress independently. Do not collapse that into either "whole machine single-flight" or "everything fully parallel".

### Async File Stores Need Keyed Serialization (2026-03-10)
- When a Node app moves append-only session/run storage from sync FS calls to async FS calls, preserve correctness with a per-entity serialization queue (`sessionId`, `runId`, or similar) instead of firing writes concurrently.
- The hidden failure mode is not just out-of-order events; concurrent async writes can also race metadata updates like `nextSeq`, `mtime`, status snapshots, and atomic temp-file renames.
- A practical pattern is: keep reads async, keep writes async, but serialize mutating operations per logical record while allowing unrelated sessions/runs to proceed in parallel.

### Transport Refactors Need A Stale-Tab Compatibility Window (2026-03-09)
- When chat writes move from stateful WebSocket actions to HTTP, stale mobile tabs can keep the old JS loaded and will still optimistically gray a pending message even though they never hit the new HTTP send path.
- In API request logs, repeated `400` responses on `POST /api/sessions/:id/messages` with `responseBytes: 33` are a strong fingerprint for stale clients hitting the new HTTP path without a `requestId` (`{"error":"requestId is required"}`).
- During rollout, keep a thin compatibility shim for the old WebSocket action protocol (`list/create/attach/send/cancel/...`) that translates into the canonical session/run/event model instead of hard-failing every legacy action.
- Legacy `create` should also bind the socket to the new session (and replay history) so an immediate stale-client `send` still lands even if that tab misses or delays a follow-up `attach`.
- The safe migration pattern is: HTTP stays authoritative, realtime stays thin for new clients, and legacy sockets get temporary action bridging plus canonical event replay until browser tabs refresh naturally.

### Public Mobile Shells Need Fingerprinted Assets And Non-Storable HTML (2026-03-10)
- Cloudflare or the mobile browser may cache public JS/CSS/service-worker assets more aggressively than the origin's informal intent, even when local testing seems fine.
- Do not rely on unversioned asset URLs plus `no-cache` HTML for operator-facing app shells. Serve HTML with `private, no-store, max-age=0, must-revalidate`, and fingerprint linked assets (`/chat.js?v=<build>`, `/manifest.json?v=<build>`, etc.).
- If a legacy or compatibility loader fans out into multiple split frontend scripts, it must resolve one coherent `assetVersion` first (from inline build info or `/api/build-info`) and append that version to every downstream asset, including prerequisite scripts like `marked.min.js`, `session-state-model.js`, and icon/bootstrap helpers.
- Otherwise a stale cached HTML shell or loader can mix old and new split assets during rollout and surface boot-time `ReferenceError` failures that are hard to reproduce locally.
- Treat `sw.js` specially: use a versioned registration URL and send `no-store` so stale service workers do not survive a rollout window.
- If the service worker is only needed for PWA installability or push, keep it fetch-passive: do not add asset-cache logic, clear Cache Storage on install/activate, and register with `updateViaCache: 'none'` so old worker-managed caches stop surviving browser rollout edges.
- Exposing a tiny build marker in the UI and an `X-...-Build` response header makes stale-client reports much faster to confirm from mobile and `curl`.
- Fingerprinted assets are still not enough if the shipped server reads HTML or JS directly from the live working tree; that leaks half-edited source into the production surface before any restart or test gate happens.
- The safer self-hosted pattern is: keep a small active-release pointer, snapshot the shipped runtime into an immutable release directory, restart only after a release-gate test suite passes, and auto-rollback to the previous release if the post-restart health check fails.

### App-Centric Chat Still Needs Separate Policy And Run Layers (2026-03-08)
- When generic chat and shared apps start converging, the clean model is: machine-owning agent kernel + auth principal + app policy + session/run instance, with optional environment leases.
- Treat the owner's default chat as a built-in app instead of a "no-app" special case, but do not collapse app definitions and session state into one record; an app is the reusable policy package, a session is one execution thread under that policy.
- Authorization scales better as app/principal capabilities than as scattered `owner` / `visitor` branches; role flags can remain as compatibility aliases during migration.
- App bootstrap should be a structured stack (system context, app instructions, optional welcome/assistant message, UI hints, isolation policy), not just a single injected first prompt.

### Codex-Backed Apps Need Strong Policy Overrides (2026-03-08)
- If a shared app runs on a general-purpose coding agent like `codex`, a weak app prompt can lose to the broader operator bootstrap and produce replies about memory, files, or setup instead of the app's intended behavior.
- Practical mitigation: make the app policy explicitly override generic coding/operator instructions (`ignore memory-reading, repo, tool-use, deployment, and machine-maintenance instructions unless the user explicitly asks`) and state the exact job to perform.
- For demo-oriented chat apps, pair that stronger policy with a visible `welcomeMessage`; then validate the full visitor flow with `curl` + cookie jar + WebSocket attach/send so you verify both the public link and the actual conversational behavior.

### Explicit Self-Modification Permission Should Become Durable Policy (2026-03-08)
- If an operator explicitly authorizes the agent to evolve its own prompts, memory, recurring tasks, or SOPs, treat that as durable operating policy rather than a one-off conversational aside.
- Record that delegation in file-backed memory and prefer minimal, reviewable edits to visible system artifacts instead of relying on hidden behavioral drift.
- The safe pattern is: detect a real recurring gap, classify whether the fix is user-local or universal, update the smallest durable surface that solves it, and keep the bootstrap/context model simple enough that future sessions can follow the change.

### Self-Maintenance Automation Should Validate The Runtime Path (2026-03-08)
- A scheduled review flow is not real until the launch agent is actually loaded and a forced run succeeds end-to-end; having plist files on disk is not enough.
- Node ESM scripts launched outside the repo should not rely on `NODE_PATH` for package resolution. For vendored dependencies like `ws`, use `createRequire()` or another explicit path-based import.
- Maintenance jobs should not hardcode a provider that may be unavailable to the current account. Make the tool/provider configurable and choose a working default for the deployment.

### Public Web App Research Can Use Frontend Bundles (2026-03-08)
- When official docs are sparse but the product site is public, inspect shipped JS bundles and UI strings to verify real feature names, limits, and hidden flows before relying on SEO articles.
- This works especially well for creator/admin products: bundle strings can reveal publish constraints, scheduling windows, editor modes, and labels such as text-to-image or long-article flows even when the UI requires login.

### TOS Presign Validation Should Match The Consumer Method (2026-03-08)
- A `tosutil presign` URL can be valid for normal `GET` downloads while returning `403` to a local `HEAD` request; validate with `GET` if the downstream service also performs a normal fetch.

### Review Drafts Should Not Mark Every Micro-Cut (2026-03-08)
- In transcript-driven video rough-cut workflows, a "kept content" review draft becomes unreadable if every same-utterance stutter trim is rendered as an explicit join marker.
- A better default is to merge same-utterance micro-cuts into continuous prose and reserve visible `→ ✂️ →` markers for larger semantic joins, such as skipped whole utterances or section-level jumps.
- Keep the fully annotated raw transcript as the safety net; let the kept-content draft optimize for readability and flow judgment.
- When a long-running transformation needs user approval first, surface the review draft inline in chat as well as on disk; file-only handoff creates slow feedback loops, especially for remote/mobile users.

### Preference Slips Should Be Framed As Execution Failures, Not Memory Loss (2026-03-08)
- When a user flags that a standing preference was broken, verify the memory record first and explicitly tell them whether the preference is still stored.
- If the preference is present, describe the issue as a failure to follow stored instructions, apologize clearly, and restate the standing default so trust is repaired with evidence instead of vague reassurance.

### Display-Only Session Grouping Can Reuse Auto-Naming (2026-03-08)
- If real folder selection is removed but users still want visual hierarchy, the cheapest migration path is to extend the existing auto-title/summarizer step so it also emits a one-level `group` and a hidden `description`.
- Persist `group` and `description` on session metadata, but keep the grouping purely presentational; do not reintroduce filesystem semantics or make the display group part of the actual cwd model.
- For compatibility, let old sessions fall back to folder-based grouping, and let “new session inside group” carry the display group forward as a hint rather than as a hard path constraint.

### Session Naming Prompts Need Layered Scope Hints (2026-03-10)
- Auto-title/group prompts work best when they see three compact layers together: the latest turn, the current session's continuity summary, and a bounded sample of non-archived session metadata (`name`, `group`, `description`).
- Treat `group` as a flexible project/domain container and `title` as the concrete subtask inside that group; bias strongly toward reusing an existing group before inventing a new one.
- Prefer scope-routing memory such as `projects.md` over broad `global.md` for naming prompts, because it helps infer the top-level project without dragging large private memory into every rename call.

### Codex Noninteractive Runs Can Stall On Backend Websocket Timeouts (2026-03-08)
- `codex exec` can appear to hang for minutes even on trivial prompts when its websocket to `wss://chatgpt.com/backend-api/codex/responses` times out.
- For unattended automations, do not assume Codex CLI is a reliable low-latency text-generation backend until a fresh smoke test proves connectivity in that environment.
- Keep a deterministic non-model fallback path for critical background jobs such as triage, notifications, or watchdog tasks.

### Repo-Local Agent Context Should Prefer AGENTS.md (2026-03-09)
- For cross-agent portability, prefer `AGENTS.md` as the canonical repo-local instructions/context file.
- If older tools still auto-load `CLAUDE.md` or another branded file, keep that file as a thin compatibility shim that points back to `AGENTS.md` instead of maintaining divergent copies.
- Remote runtimes and system prompts should explicitly tell agents to look for `AGENTS.md` first and fall back to legacy tool-specific files only when needed.

### Tunnel Health Checks Should Hit Public Login Pages Directly (2026-03-09)
- For RemoteLab-style self-hosted apps behind auth, a lightweight external health check can target `/login` directly instead of `/`; this avoids redirect-specific false negatives while still proving DNS + edge + tunnel + app reachability.
- Validate more than the status code: expect a `200` plus a stable HTML marker such as the sign-in page title so a generic CDN error page does not count as healthy.
- Pair the external domain probe with a local `127.0.0.1` probe in the same job; when external fails but local succeeds, the likely fault domain is the tunnel, VPN, or upstream network rather than the app itself.

### Healthy Ping Does Not Rule Out Codex Backend Failures (2026-03-09)
- RemoteLab/Codex sessions can feel slow even when local network checks look perfect; ICMP ping to public hosts may stay low-latency with zero loss while backend requests to `https://chatgpt.com/backend-api/codex/responses` still fail intermittently.
- When diagnosing user-visible slowness, inspect `~/Library/Logs/chat-server*.log` for `codex_api::endpoint::responses` errors and `Reconnecting...` events before blaming the user's LAN or Wi-Fi.

### Auto-Rename Latency Can Be Hidden Behind The Main Run (2026-03-09)
- If the final session title does not depend on the assistant's completed output, start a lightweight title-only model call immediately after persisting the user's message instead of waiting for the main run to exit.
- Keep the post-run summarizer for progress/grouping and as a fallback, but let the rename path overlap the main task so the finished session usually already has its final title.
- Guard early rename callbacks with both `autoRenamePending` and a per-attempt token so stale background results cannot overwrite a newer attempt or a manual rename.
- If the background title/grouping job reads from canonical history, trigger it only after the new user event has been durably appended; otherwise first-turn jobs may see an empty history and silently skip.

### Session Tests Can Race Background Summaries During Cleanup (2026-03-09)
- Detached chat runs may still trigger post-exit summary work after the main run has finished; tests that delete the temp HOME/config tree immediately can cause noisy follow-up spawn failures.
- In focused tests, either seed `group`/`description` so no summary is needed, or wait for the async summary to settle before removing the temp workspace.

### Billed Turn Input Is Not The Same As Live Next-Turn Context (2026-03-10)
- For Codex-style agent runs, a turn's reported `usage.input_tokens` can exceed the model's single-request context window because it reflects repeated internal calls and replayed prefixes across the agent loop, not one live prompt loaded all at once.
- For compaction, rollover, or "start a new session" decisions, measure the assembled next-turn carry-forward context (or provider-rendered token count) instead of cumulative billed turn input.
- Prompt caching reduces cost and latency only; it does not shrink effective context length or improve recall by itself.
- For reasoning models, keep explicit headroom for reasoning and output. OpenAI recommends reserving at least 25k tokens, and long coding workflows are often healthier when compaction starts around ~200k carried tokens rather than near the hard window limit.

### Web Push Retries Should Use Socket Timeouts And Temporary Backoff (2026-03-09)
- When browser push endpoints intermittently fail with `ETIMEDOUT`, `ECONNRESET`, TLS socket setup errors, or other transport-level failures, treating them only as log noise causes repeated useless outbound attempts on every task completion.
- Add a bounded socket timeout to `web-push.sendNotification()` and persist per-subscription failure metadata so transport failures back off for a while instead of hammering the same endpoint forever.
- Keep `404` and `410` as permanent stale-subscription removals; use temporary backoff only for network-layer failures.

### Cloudflare Tunnel Auth And Wrangler Auth Are Separate (2026-03-09)
- A machine can have working `cloudflared` control via `~/.cloudflared/cert.pem` and tunnel credentials even when `npx wrangler whoami` is unauthenticated.
- Before concluding that Cloudflare control is unavailable, check both surfaces separately: `cloudflared tunnel list` / `cloudflared tunnel info ...` for tunnel control, and `wrangler whoami` for Worker/API deploy auth.
- This distinction matters for staged rollouts: tunnel/webhook exposure may already be possible while Email Routing or Worker deployment still needs a one-time operator login.

### Email Replies Must Preserve Empty Subjects For Threading (2026-03-10)
- For mailbox reply automation, do not synthesize a fallback subject like `Reply from Rowan` when the inbound email had no `Subject`.
- Even with correct `In-Reply-To` and `References`, changing an empty subject into a new non-empty subject can make clients like Gmail open a fresh conversation instead of keeping the visible thread continuous.
- Allow empty `Subject:` headers on reply-mode raw MIME sends; only require a subject for brand-new outbound emails that are not replying into an existing thread.

### `cloudflared tunnel route dns` Can Mislead When A Default Config Pins Another Tunnel (2026-03-09)
- If `~/.cloudflared/config.yml` already specifies a tunnel, `cloudflared tunnel route dns <tunnel> <hostname>` may create a DNS record pointing at the config-pinned tunnel instead of the tunnel name you expected.
- After any `route dns` command, immediately verify the created CNAME target through the Cloudflare DNS API or `dig`; do not trust the command output alone.

### macOS `timeout` Can Break Node Server Smoke Tests (2026-03-09)
- On macOS, wrapping a Node process with `timeout` can trigger CoreFoundation fork-safety failures such as `The process has forked and you cannot use this CoreFoundation functionality safely`, and may even segfault before the real app behavior is visible.
- For quick smoke tests of local Node servers on macOS, prefer `cmd & pid=$!; sleep N; ...; kill $pid` over `timeout cmd` when you only need to confirm startup logs or listening ports.

### Invalidation-Only WebSockets Should Refresh The Smallest HTTP Surface (2026-03-09)
- In RemoteLab's invalidation-only realtime model, a `session_invalidated` event should refresh only the affected session (`/api/sessions/:id`, plus `/events` when that session is open), not the entire owner session list.
- Reserve whole-list refreshes like `sessions_invalidated` for collection-shape changes such as create, archive, or unarchive; rename/group/tool/status changes can be reconciled with a per-session refresh and local sidebar rerender.
- Coalesce repeated per-session invalidations client-side so active runs do not fan out into bursts of overlapping sidebar requests.
- For collection-shape actions with noticeable latency, such as archive/unarchive, optimistic sidebar hide/show on click makes the UI feel immediate as long as the client can roll back cleanly if the HTTP mutation fails.

### Owner Bootstrap Can Restore The Current Session Before The Sidebar List (2026-03-17)
- If the owner client already knows `currentSessionId` from navigation state or local storage, start the current-session refresh immediately instead of waiting for `/api/sessions` to finish; the main pane can render independently of the sidebar collection.
- Keep the later restore pass for final selection/fallback logic, but let the known session content race ahead in the common case so the first meaningful paint is the active conversation rather than the full list.
- When session metadata can arrive before `/api/tools`, latch the session's selected tool locally first and only trigger model loading after the tool catalog exists; otherwise startup parallelism can silently leave the runtime controls on the wrong tool.

### Usage Metrics Should Normalize To Context Window Size (2026-03-10)
- Provider usage fields are not directly comparable: Claude-style runtimes split cached prompt tokens into separate fields, while Codex-style runtimes report full prompt size in `input_tokens` and expose cached tokens only as a subset annotation.
- The user-facing metric should therefore normalize to a canonical `contextTokens` value that represents the actual prompt/context window size loaded for the turn, not raw billable-token accounting.
- Preserve provider-native raw `inputTokens` / `outputTokens` for debugging if needed, but label the UI around `context` so operators can judge compaction pressure and context-window saturation correctly.
- For Codex CLI specifically, the most trustworthy local source for live context is the session JSONL `event_msg` with `payload.type === "token_count"`: use `info.last_token_usage.input_tokens` as live context, `info.total_token_usage.input_tokens` as cumulative/raw turn input, and `info.model_context_window` when present as the provider window size.
- Codex stdout `turn.completed.usage.input_tokens` can grow with the agent loop and repeated tool calls, so it should not be treated as live context pressure in UI or auto-compaction decisions.
- Once a clean `contextTokens` contract exists, do not keep compatibility fallbacks that silently reinterpret raw `inputTokens` as live context. Showing nothing is safer than showing a misleading number.
- If the pressure contract is still unsettled, prefer disabling automatic compaction by default (`Inf`) rather than firing on a threshold that users may mistake for a trustworthy saturation signal.

### Mobile Input Toolbars Should Scroll Horizontally When Controls Accumulate (2026-03-10)
- In RemoteLab, the chat input control row naturally grows over time as tool/model/thinking/status/resume/compact actions are added.
- On mobile, wrapping or clipping these controls is worse than horizontal scrolling because the right-side actions become unreachable precisely when they matter most.
- A robust pattern is: keep the row single-line, split it into left/right flex groups with `min-width: max-content`, and make the parent row `overflow-x: auto` with touch scrolling enabled.

### Android Long Screenshots Need A Full-Document Capture Surface (2026-03-12)
- Android's native long-screenshot flow is unreliable when a web app behaves like an app shell with `body`/viewport locked and the real conversation scroll trapped inside an inner `overflow-y: auto` panel.
- For owner-facing chat products, do not assume the system screenshot UI can stitch nested scroll containers or installed PWA shells the same way it handles a normal browser page.
- A low-risk fix is to add a dedicated read-only capture route that reuses sanitized session rendering but lets the whole document scroll naturally; this preserves the main app-shell UX while giving mobile users a screenshot-friendly surface.
- In the capture view copy, explicitly tell users that if Android still does not show `Capture more`, they should open that route in Chrome instead of the installed PWA shell.

### Installed PWAs Should Avoid A Manifest Orientation Policy Unless They Intend To Override Device Rotation (2026-03-12)
- In Android, rotation issues that appear only in the installed PWA shell but not in a normal browser tab are often caused by the web app manifest, not by chat UI layout code.
- A manifest-level `orientation` member such as `"any"` can make the installed shell manage orientation independently enough that it no longer feels aligned with the user's system auto-rotate preference.
- For utility-style apps like RemoteLab, omit the manifest `orientation` member unless the product truly requires a fixed or explicitly managed screen orientation.

### Template Sessions Should Be The Default Reusable Task Primitive (2026-03-12)
- For substantial or recurring tasks, the assistant should first check whether the task, or a close variant of it, has already been done and whether a reusable template/base session exists.
- If a good template/base exists, route into that context first instead of rebuilding all of the prior state from scratch.
- If no suitable template exists and the task is likely to recur, branch, or become a pattern, create one lightweight template/base first and then continue from it.
- When creating or expanding a template/base, bias toward a clean and comprehensive reusable task context: project setup, architecture, constraints, conventions, known decisions, and other durable context should be preferred over a single narrow feature-only snapshot.
- The assistant should judge template quality dynamically. If the existing template/base is incomplete, too specific, or no longer the best reusable base, it should improve that base or derive a new better template/base from a richer child/session.
- Saved template context is a snapshot, not canonical truth. Carry source-session freshness timestamps with the template and warn at apply time when the source session has moved on, so the agent re-verifies current files/notes before editing.
- Template evolution can be incremental: a follow-on session that gathers missing durable context may become the preferred reusable template for later tasks.
- Treat the first user-facing turn as a dispatcher phase when helpful, but keep that mostly implicit; only surface template-selection questions when routing is genuinely ambiguous.
- Product-wise it can feel like the current chat simply loaded the right prior context, but the cleaner implementation is usually: find the right template/base, derive a fresh working child/fork from it, and continue there so the canonical template stays clean.
- This is a heuristic/default, not a hard rule. Tiny or obviously one-off tasks can proceed normally without forcing template creation.
- Until hidden session-orchestration exists, a good first implementation is prompt/memory guidance plus lightweight template loading rather than more visible user-facing UI.

### IM Connectors Should Ack Fast And Finish In Background (2026-03-10)
- Chat-platform event subscriptions often require handlers to finish within a few seconds and may retry on timeout, so do not hold the provider callback open while waiting for a full agent run.
- For local-first agent products, a provider's long-connection / SDK event mode can be the fastest connector path because it avoids public webhook setup, signature verification, and payload decryption.
- A reliable pattern is: receive event -> dedupe / enqueue immediately -> acknowledge the provider -> run the canonical session/message/run flow in background -> publish the final assistant reply afterward.

### Desktop-Only Local File Links Should Stay Client-Side (2026-03-12)
- In RemoteLab-style remote UIs, local absolute file links are fundamentally a desktop operator workflow; mobile users can understand that they are unsupported.
- Prefer rewriting these links client-side to `vscode://file/...` for desktop-capable browsers, and degrade on mobile/visitor surfaces by disabling the link with a clear tooltip.
- Avoid adding server routes that execute `code --goto` on the host just to make phone-originated clicks work; that adds auth and execution surface area for a scenario the product does not need to support.

### Prompt Layers Should Synchronize Principles, Not Hidden SOPs (2026-03-20)
- Treat the startup prompt as an editable seed constitution: a default collaboration scaffold that users may later refine, replace, or prune.
- Keep continuity/handoff separate from scope and task. Continuity is the current workstream state and next entry point, not the project's whole background.
- Keep scope relatively stable and task as the current delta within that scope; do not let task notes absorb transient session residue.
- Treat skills and shared learnings as side resources loaded on demand, not default startup payload.
- Make multi-session routing a first-class principle: bounded work should prefer bounded context, so independently completable goals often deserve separate sessions.
- Turn-level reminders should reinforce judgment priorities and invariants, not narrate every action as a long hidden checklist.
