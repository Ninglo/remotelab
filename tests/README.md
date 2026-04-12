# Tests

Scenario-style validation scripts now live in this directory instead of the repo root.

- Run the current smoke suite with `npm test`.
- Pull requests run the same smoke suite automatically via GitHub Actions in `.github/workflows/ci.yml`.
- Run a specific script with `node tests/<name>.mjs`.
- Run the live agenda-agent smoke with `npm run test:live:agenda-agent`.
- `tests/chat` and `tests/lib` are symlinked import roots so existing relative test imports stay stable after the move.

Live agent smoke tests are intentionally opt-in because they spend real model/runtime budget and hit the running owner instance.

- `tests/test-agenda-agent-live-smoke.mjs` validates the end-to-end `remotelab agenda` flow through a real agent session.
- Default smoke profile is `codex` with `effort=low`.
- Override the smoke agent with `REMOTELAB_SMOKE_TOOL`, `REMOTELAB_SMOKE_MODEL`, and `REMOTELAB_SMOKE_EFFORT` when you want to trial a cheaper or alternate profile.

High-value smoke scripts:

- `tests/test-session-naming.mjs`
- `tests/test-cloudflared-config.mjs`
- `tests/test-history-index-contract.mjs`
- `tests/test-session-route-utils.mjs`
- `tests/test-session-external-trigger-refresh.mjs`
- `tests/test-session-label-prompt-context.mjs`
- `tests/test-agent-mailbox.mjs`
- `tests/test-agent-mail-worker.mjs`
- `tests/test-agent-mail-reply.mjs`
