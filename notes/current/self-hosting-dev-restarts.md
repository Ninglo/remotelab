# Self-Hosting Dev Restart Strategy

> Transport/runtimes are now HTTP-first with detached runners. This note stays focused on honest restart behavior for the single shipped chat plane.

## Brutal truth

If the same `chat-server` process is both:

1. the thing carrying your live browser tab, and
2. the thing you are restarting,

then **transport continuity is still impossible by definition**.

What changed is the important part underneath that transport break:

- the browser no longer depends on live event streaming for correctness
- active runs can keep going in detached sidecars
- the control plane can restart, re-scan durable run output, and converge back to the same state

So the honest promise is now stronger than before, but still bounded:

- **No promise:** zero-disruption live socket continuity
- **Actual promise:** restart-safe control-plane recovery with durable HTTP state and detached active runs

## Current reusable workflow

### 1. Treat restart as transport interruption, not run loss

When the control plane shuts down during an active run:

- the browser loses its current socket / page continuity
- the detached runner keeps writing `status.json`, `spool.jsonl`, and `result.json`
- after reconnect, HTTP reads rebuild session and run state from durable files

For older explicitly interrupted cases where resume metadata was captured, the UI may still show **Resume**. That is now a compatibility recovery path, not the main restart story.

### 2. Operational sequence

1. Work and code from `7690`
2. Restart `7690` when needed
3. Re-open / reconnect the chat UI
4. Validate the change through HTTP/state recovery, not socket continuity
5. Use `Resume` only when a specific interrupted run captured resumable metadata

## What the current architecture solves

- repeatable single-plane restart workflow
- HTTP-canonical recovery after refresh/reconnect
- detached active runs surviving control-plane restarts
- optional WS invalidation hints instead of mandatory event streaming

## What is still intentionally out of scope

- zero-downtime browser transport continuity
- WebSocket replacement / transport redesign
- database migration beyond local filesystem storage

## Recommendation

Prioritize in this order:

1. Keep `7690` as the primary coding/operator plane
2. Validate restart behavior through HTTP state recovery, not stream continuity
3. Use ad-hoc manual instances only when a task explicitly benefits from them
4. Defer transport swaps and DB changes until they are separately justified

## Deferred cleanup TODO

- Keep the temporary legacy-upgrade cleanup in `setup.sh` for now so users who have not updated yet still get old `auth-proxy` / `ttyd` artifacts removed automatically.
- Revisit removing that cleanup after roughly 2–4 weeks, once the terminal-fallback removal has had time to propagate.
