# Self-Hosting Dev Restart Strategy

## Brutal truth

If the same `chat-server` process is both:

1. the thing carrying the live conversation, and
2. the thing you are restarting,

then **mid-turn continuity is impossible by definition**.

You can improve recovery. You cannot honestly promise zero-loss live streaming unless the runner lifetime is decoupled from the web server lifetime.

## Current reusable workflow

### 1. Split operator plane from target plane

- **Operator plane:** stable `7690` chat service
- **Target plane:** `7692` test service (or another manual port)
- **Emergency fallback:** `7681` auth-proxy terminal

Rule: **do not drive development from the same instance you expect to restart repeatedly**.

Use `7690` to edit code, restart `7692`, inspect logs, and verify the test deployment.

### 2. Standardize manual test-instance management

Use `scripts/chat-instance.sh` for custom-port chat-server instances.

Examples:

```bash
scripts/chat-instance.sh restart --port 7692 --name test
scripts/chat-instance.sh status --port 7692 --name test
scripts/chat-instance.sh logs --port 7692 --name test
```

This removes the current ad-hoc habit of manually killing whatever happens to be on `7692`.

### 3. Treat restart as interruption + recovery, not fake continuity

When the server shuts down during an active run:

- the run is marked as **interrupted**
- captured Claude/Codex resume IDs are persisted immediately
- after reconnect, the UI can show **Resume** for recoverable turns

This is the honest model:

- **No promise:** “your in-flight stream keeps going”
- **Actual promise:** “your interrupted turn is explicitly recoverable if resume metadata exists”

### 4. Operational sequence

1. Work from `7690`
2. Restart `7692`
3. Re-open / reconnect `7692`
4. If the previous turn was interrupted and recoverable, press **Resume**
5. If both chat services are broken, fall back to `7681`

## Why this is only phase 1

This still kills the in-process child runner during server restart.

That means phase 1 solves:

- repeatable restart workflow
- explicit interruption state
- resumable recovery

It does **not** solve:

- true zero-downtime streaming
- preserving an active subprocess while the web server restarts

## Real phase 2 architecture

If we want genuine restart-safe development, the architecture needs one of these:

### Option A — stable gateway + drainable workers

- one stable front process owns the public port / WebSocket endpoint
- chat workers run behind it on internal ports
- restart means: start new worker → health check → switch router → drain old worker

Good for reducing connection churn.
Still not ideal if session runners live inside workers.

### Option B — detached per-session runners

- each AI session runs under a separate local supervisor / daemon
- chat-server becomes stateless control plane + event replay layer
- server restart does not kill the active tool process

This is the first architecture that can honestly claim **restart-safe active runs**.

## Recommendation

Prioritize in this order:

1. **Now:** use `7690` as operator plane, `7692` as target plane
2. **Now:** use `scripts/chat-instance.sh` for custom-port instances
3. **Now:** rely on interrupted-turn recovery instead of pretending restarts are harmless
4. **Next major step:** design detached session runners

Anything weaker than that is just nicer failure, not a real fix.
