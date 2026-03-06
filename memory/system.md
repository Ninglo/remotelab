# System-Level Memory — RemoteLab

Universal learnings and patterns that apply to all RemoteLab deployments, regardless of who runs it or on which machine. This file lives in the code repo and is shared with all users.

## What Belongs Here

- Cross-platform gotchas (macOS vs Linux differences)
- Common failure patterns and their root causes
- Effective prompt patterns and anti-patterns
- Best practices for tool orchestration (Claude Code, Codex, etc.)
- Architecture insights that reduce future debugging time

## Learnings

### Context Continuity Across Restarts (2026-03-06)
- Claude Code's `--resume <session_id>` flag is the ONLY mechanism for conversation continuity. Without it, every spawn starts a completely fresh session regardless of what the UI shows.
- Any in-memory state critical for continuity (session IDs, thread IDs) MUST be persisted to disk. In-memory Maps are wiped on process restart.
- The UI chat history (stored in JSON files) and the AI's actual context (controlled by `--resume`) are completely independent. Users will see old messages but the AI won't remember them — a confusing UX failure mode.
- Fix: persist `claudeSessionId`/`codexThreadId` in the session metadata JSON, rehydrate into memory when the session is first used after restart.
- **Rehydration ordering trap**: WebSocket `subscribe`/`attach` creates a bare `live` entry in the in-memory Map BEFORE `sendMessage` runs. If rehydration is gated on `!live`, it gets skipped. Rehydration must check the live entry's fields, not its existence.

### Testing Strategy for Self-Hosted Services (2026-03-06)
- Never restart the server you're running on to test restart-survival features. Spin up a separate instance on a different port (e.g., 7694) and run the full test cycle there.
- Use node WebSocket client for API testing — match the actual protocol (`action` field, attach-before-send flow).

### Tool Selection State Must Be Split (2026-03-06)
- If the UI supports switching tools mid-session (e.g. Claude → Codex), the session metadata on disk MUST be updated when the switch happens. Otherwise reload/reattach paths snap the selector back to the stale `session.tool`.
- The active session tool and the user's default tool preference are different states. Reusing one variable for both causes "it keeps forgetting my default" bugs whenever the user opens an older session.

### Codex Home Directory Trust Check (2026-03-06)
- `codex exec` can hard-fail with `Not inside a trusted directory and --skip-git-repo-check was not specified.` when `cwd` is the user's home directory, even if approvals/sandbox are already bypassed.
- In RemoteLab, this presents as a "silent" or "no response" Codex session because the process exits before emitting JSON events; Claude does not have this constraint, so the mismatch looks path-specific.
- If the product intentionally launches agents from `~` or other non-repo roots, pass `--skip-git-repo-check` in the Codex adapter (or explicitly trust that directory in Codex config).

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
- Reliable pattern: query `/api/auth/me` on every page load, derive mode from the authenticated role, and then decide whether to load owner-only surfaces like tools, models, settings, sidebar state, or push registration.

### Hidden Markdown Blocks Work Best As Parser Extensions (2026-03-06)
- For `marked`, custom block + inline extensions are a clean way to consume tags like `<private>...</private>` and `<hide>...</hide>` so the UI hides them while the raw message text stays intact for history and model context.
- After rendering, skip empty assistant bubbles; otherwise a response that only contains hidden blocks still leaves blank UI chrome behind.
