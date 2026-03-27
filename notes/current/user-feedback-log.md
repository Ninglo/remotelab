# Shared User Feedback Log

Status: active evidence log as of 2026-03-26

Companion operating note: `notes/current/product-mainline.md`

Directional synthesis: `notes/directional/product-vision.md`

## Purpose

- Keep product feedback visible to both human and AI collaborators.
- Preserve the signals that should change product judgment without storing raw private transcripts in the repo.
- Make it easy to see what repeated evidence already exists before starting new product discussions.

## Capture rules

- Log only sanitized product evidence.
- Prefer short entries with clear implications.
- Merge repeated evidence into existing themes when possible instead of duplicating near-identical entries.
- When a signal becomes stable product direction, promote it into `notes/directional/product-vision.md`, `README.md`, `README.zh.md`, or a current execution note.

## Current carried-forward signals

### 2026-03-27 — mobile session entry must be visually primary, not hint-dependent

- Source: direct product feedback during phone-first chat-shell review
- User slice: mobile-first owner using RemoteLab without product-specific habits yet
- Observed friction or ask: the left header entry for sessions/sidebar is too easy to miss; if users skip or forget a hint, they may not understand how to switch sessions. `Fork` adds clutter while `Share` can stay only as a lighter secondary action.
- Signal: important mobile navigation cannot depend on onboarding hints or hidden gestures; the persistent UI itself must make the session entry feel obviously tappable and primary.
- Product implication: make the left header sessions control visually heavy, remove `Fork` from the top bar, and keep `Share` as a lighter secondary button that still reinforces icon clickability.
- Promote to: mobile header defaults, session navigation UX review
- Follow-up: watch whether stronger primary navigation reduces missed-sidebar confusion without requiring extra coaching copy

### 2026-03-26 — shrink product concepts before refactoring deeper

- Source: direct product strategy discussion after parallel architecture review
- User slice: owner/operator using RemoteLab as a single-owner AI workbench
- Observed friction or ask: `App`, `User`, and interactive `Visitor` concepts add conceptual and implementation weight without enough real pull, while `Welcome` as an App feels artificial compared with a normal seeded session
- Signal: the near-term product should contract toward owner sessions, runs, and read-only share snapshots; onboarding should use a normal session or injected first assistant message, not a special App object
- Product implication: remove app/user CRUD, filters, visitor entry flow, and welcome-app framing before deeper backend/frontend refactor so later cleanup targets a smaller and clearer product truth
- Promote to: `notes/current/product-mainline.md`, `notes/current/session-first-product-contraction.md`, `notes/current/core-domain-refactor-todo.md`
- Follow-up: first removal wave should target sidebar filters/settings, app/user routes, visitor entry flow, and welcome bootstrap

### 2026-03-26 — attachment entry should use clear upload wording, not icon-only affordance

- Source: direct product feedback during chat-composer review
- User slice: mobile-first owner using the default chat input without prior RemoteLab habits
- Observed friction or ask: an icon-only attachment control is easy to miss or misread; users may not infer that it is the file upload entry point
- Signal: attachment entry should be placed early in the composer control row and use explicit upload wording instead of relying on icon recognition alone
- Product implication: mainstream intake flows should prefer clear labeled actions over compact icon-only affordances for important first-step actions like uploading examples or source files
- Promote to: composer UX defaults, future intake/onboarding review

### 2026-03-26 — abstract welcome needs concrete showcase examples

- Source: direct product discussion after reviewing fresh-instance onboarding
- User slice: first-time owner opening a newly created RemoteLab instance on mobile
- Observed friction or ask: a pure conversational welcome is still too abstract; users need to see a few concrete finished cases before they understand what they can hand off
- Signal: new instances should not rely only on generic intake copy; onboarding should expose 3–5 example workflows with visible outcomes, such as a scheduled news digest emailed to the user, an uploaded Excel file cleaned and returned as a result file, or an incoming email that opens a new processing session automatically
- Product implication: Welcome should teach capability through clearly labeled example sessions that let users read a believable end-to-end flow — the starting ask, intermediate handling, and final deliverable — so they learn how to use the product by following a real transcript rather than by interpreting abstract capability cards
- Promote to: `notes/directional/product-vision.md`, welcome/onboarding implementation
- Follow-up: seed fresh instances with 3–5 pinned showcase sessions; if lightweight visual entry points are still useful, keep them as simple labeled launchers into those example transcripts rather than as self-contained explanatory cards; keep the first canonical scripts in `notes/directional/product-vision.md`

### 2026-03-26 — new instances need an auto-open welcome session, not an empty chat shell

- Source: direct user feedback while testing a fresh trial instance
- User slice: first-time owner opening a newly created RemoteLab instance on mobile
- Observed friction or ask: landing on an empty session list (or a stray blank default chat) gives no guidance and makes the product feel broken instead of guided
- Signal: new instances should auto-create the built-in Welcome session and open it by default; zero-active-session owner states should prefer guided recovery over an empty shell
- Implication: server-side bootstrap should guarantee an active Welcome session for owner-first entry, and onboarding must be resilient to legacy blank archived sessions
- Promote to: onboarding implementation, welcome-session regression tests

### 2026-03-26 — showcase demos should combine real workflow value and explain mail gating up front

- Source: direct onboarding feedback after reviewing seeded starter sessions
- User slice: first-time owner trying to infer what RemoteLab can reliably automate from example transcripts
- Observed friction or ask: separate one-capability demos understate value; a stronger showcase combines content collection/summarization with delivery, and the inbound-email affordance currently hides the allowlist prerequisite
- Signal: starter examples should prefer believable end-to-end flows such as “summarize current industry signals and send the digest to a target inbox” instead of showcasing isolated primitives; any mail-to-instance affordance should warn users to register their sender address before testing so the first attempt does not get silently filtered
- Product implication: onboarding examples should teach compound outcome-oriented workflows, while Welcome should surface the sender-allowlist safety gate in plain language before users try inbound email
- Promote to: welcome/bootstrap copy, starter-session design, email-onboarding defaults

### 2026-03-25 — mainstream automation framing beats orchestration-first framing

- Source: synthesis of recent user interviews and product review
- User slice: early high-fit non-technical operators and coordinators
- Signal: users respond more strongly to "hand repetitive digital work to AI" than to orchestration or session jargon
- Implication: keep multi-session and context carry as enabling-capability language, not the first-sentence product promise
- Promoted to: `README.md`, `README.zh.md`, `notes/directional/product-vision.md`

### 2026-03-25 — early high-fit users are time-pressed coordinators with digital admin work

- Source: recent interview summary
- User slice: traditional-industry middle managers and small owner-operators
- Signal: the best early users already delegate to people, still carry digital admin overhead themselves, and care sharply about saved time
- Implication: onboarding and examples should center on repetitive information work, not AI-native power-user language
- Promoted to: `notes/directional/product-vision.md`

### 2026-03-25 — first trusted automation win matters more than capability breadth

- Source: product-direction reset and interview synthesis
- User slice: mainstream guided-automation users
- Signal: people need a fast, concrete automation win before advanced workflow organization matters
- Implication: prioritize intake, welcome flow, review, delivery, and a trusted first outcome over showcasing orchestration depth
- Promoted to: `notes/directional/product-vision.md`, `notes/current/product-mainline.md`

## Entry template

### YYYY-MM-DD — short title

- Source:
- User slice:
- Recurring work:
- Observed friction or ask:
- Signal strength:
- Product implication:
- Promote to:
- Follow-up:
