# Session Dispatch Architecture

## What this is

Pre-execution message dispatch: before a message enters the normal turn lifecycle, classify whether it belongs in the current session or should be routed elsewhere.

Post-execution turn review: after a turn completes, run experience extraction / memory writeback as part of the existing turn-close autonomy window.

This note covers both hooks and how they integrate with existing infrastructure.

---

## Problem

RemoteLab targets non-technical users who do not naturally create new sessions for different topics. They tend to dump everything into one long conversation. This degrades model performance because:

- context grows stale and mixed
- prompt caching hit rate drops when topics shift
- the model wastes tokens re-establishing context every turn

The system should absorb this complexity instead of expecting users to manage sessions.

---

## Pre-execution dispatch hook

### Where it runs

In `submitHttpMessage()`, after validation and duplicate detection, **before** the queue-or-execute decision. This is approximately line 3334 in `session-manager.mjs`.

The dispatch check runs only for external user messages, not for:
- internal operations (`internalOperation` set)
- queued follow-up flushes
- self-repair continuations
- visitor sessions (scoped to their App)

### What it receives

- the incoming message text + images
- current session metadata (id, name, group, appId, description, taskCard)
- available Apps with their scope hints
- recent session list (for routing to existing sessions)

### What it outputs

A dispatch decision object:

```javascript
{
  action: 'continue' | 'route_existing' | 'route_new',
  confidence: number,       // 0-1
  reason: string,           // short explanation
  targetSessionId?: string, // for route_existing
  targetAppId?: string,     // for route_new or route_existing
  contextSummary?: string,  // relevant context to carry over
}
```

### Decision logic

- `continue`: message belongs in current session. Proceed normally.
- `route_existing`: message belongs in an existing session. Redirect there.
- `route_new`: message starts a new topic. Create new session, optionally under an App.

Low confidence (< threshold) → fall back to `continue`. Do not auto-route when unsure.

### Execution model

The dispatch classifier makes a single fast-model LLM call. It receives:
- current session summary (name, description, recent topic)
- available session summaries (name, group, description, last activity)
- available App scope hints
- the new message

The call should use a small/fast model to minimize latency.

### APP scope matching

Apps gain a new optional field `scopeHints`:

```javascript
{
  scopeHints: {
    triggers: ['植物', 'plant', '识别'],
    description: 'Plant identification and logging',
  }
}
```

This enables both keyword pre-filtering (before LLM call) and richer context for the classifier.

### Integration with existing delegation

When dispatch decides to route:
1. Create or find target session (reuse `delegateSession` patterns)
2. Submit the user's original message to the target session
3. Inject a lightweight routing notice in the source session
4. Return the routing outcome to the HTTP caller so frontend can navigate

---

## Post-execution: memory writeback

### Where it runs

Inside the existing turn-close autonomy window, as an operation type alongside self-check, compaction, label suggestion, and workflow state update.

Implemented as an extension to `runSessionTurnCompletionEffects()` in `session-turn-completion.mjs`.

### What it does

After the main turn completes:
1. Evaluate whether anything durable was learned this turn
2. If yes, write back to the appropriate memory layer (user-level or system-level)
3. Record the writeback as a `contextOp` for inspectability

### Execution model

- Fully async, non-blocking to user
- Uses the same fast-model approach as dispatch
- Runs in parallel with other post-turn effects (label suggestion, workflow state)
- Only fires on substantive turns, not on trivial exchanges

---

## UX contract

### Routing notification

When a message is routed away from the current session:

```
Source session shows:
  [status] "This message was handled in another session."
  [assistant message with link] "I've moved this to [session name] since it's a different topic. → [link]"

Target session shows:
  [normal user message] (the original text)
  [model responds normally]
```

Frontend behavior:
- If the user is looking at the source session, show a toast/banner with a jump link
- WebSocket invalidation fires on both sessions
- The routing notice is a lightweight assistant message, not a blocking modal

### No routing (default)

When dispatch decides `continue`, the turn proceeds exactly as it does today. Zero visible difference.

---

## Implementation files

| File | Role |
|---|---|
| `chat/session-dispatch.mjs` | New: dispatch classifier + decision logic |
| `chat/session-dispatch-prompt.mjs` | New: prompt construction for the classifier |
| `chat/session-manager.mjs` | Modified: integrate dispatch before queue-or-execute |
| `chat/apps.mjs` | Modified: add `scopeHints` field to App schema |
| `chat/session-turn-completion.mjs` | Modified: add memory writeback operation |
| `chat/prompt-assets/turn/dispatch-classifier.md` | New: editable classifier prompt template |

---

## Rollout

### Phase 1 (this PR): Get the dispatch flow working

- Add `scopeHints` to App schema
- Build `session-dispatch.mjs` with classifier
- Integrate into `submitHttpMessage()`
- Add routing notice UX
- Ship with conservative threshold (route only on high confidence)

### Phase 2: Memory writeback

- Add memory writeback to turn-completion
- Record as contextOp
- Connect to existing memory system paths

### Phase 3: Tuning

- Adjust confidence thresholds based on real usage
- Add session-level dispatch preferences
- Consider parallel dispatch + main inference for latency optimization

---

## Relation to existing design notes

- `model-autonomy-control-loop.md`: memory writeback fits as an operation in the turn-close autonomy window
- `app-centric-architecture.md`: `scopeHints` moves Apps toward the universal policy layer vision
- `session-control-state-phase1.md`: dispatch decisions should eventually project through session control state
