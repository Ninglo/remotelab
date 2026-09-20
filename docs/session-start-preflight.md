# Session Start Preflight

RemoteLab can run a short knowledge-freshness probe before the first real turn of a fresh provider session. The probe never becomes a user or assistant message, but the folded **Thought** block shows the configured probe, each attempt, the returned answer, replacement waits, and the final outcome so the startup delay is understandable. When an answer matches a configured stale marker, RemoteLab closes that provider session, waits for the configured retry window, and starts a different provider session. Preflight is warming and observability rather than an admission gate: after the configured attempts are exhausted, or after the probe cannot produce a usable result, RemoteLab still submits the original user prompt in the same durable run.

This is a heuristic freshness gate, not provider attestation. It answers “did this provider session return the configured stale signal?”; it does not prove the exact serving model or release revision.

## Enable for an instance

Create `${REMOTELAB_CONFIG_DIR:-~/.config/remotelab}/session-start-preflight.json`:

```json
{
  "version": 1,
  "enabled": true,
  "prompt": "这是 RemoteLab 启动前置预检。不要联网、不要调用工具。只回答：你所知的最新 Gemini 主版本是 X.X？仅输出版本号。",
  "restartAnswers": ["2.5"],
  "retryDelayMs": 60000,
  "maxAttempts": 3,
  "timeZone": "Asia/Shanghai",
  "tools": ["codex", "claude", "pi"],
  "runtimeFamilies": [],
  "models": [],
  "includeInternalOperations": true
}
```

Empty `tools`, `runtimeFamilies`, or `models` lists mean all values. The warming run happens only when RemoteLab is about to create a fresh provider context; resumed turns do not repeat it. A stale answer can trigger up to `maxAttempts` provider-session replacements, but exhaustion or a probe error is recorded and then fails open into the original request. Only an actual runtime failure while executing that request should fail the run.

## Daily statistics

Each attempt is written as a separate durable record below `session-start-preflight-events/YYYY-MM-DD/`. The day is assigned when the preflight starts in the configured timezone, so a retry that crosses midnight remains attached to the original trigger day.

```bash
remotelab session-preflight status
remotelab session-preflight stats --days 7
remotelab session-preflight stats --days 30 --json
```

The report keeps these states separate:

- `triggered`: fresh provider sessions for which the gate actually loaded.
- `normalLoads`: passed on the first attempt.
- `neededNewSession`: at least one attempt matched a restart answer.
- `loadedAfterRestart`: a later fresh provider session passed.
- `exhausted` and `errors`: warming did not pass, but the original request continued; these remain separate from successful warming outcomes.
- `cancelled` and `incomplete`: warming did not reach a normal recorded outcome.
- `neededNewSessionRate`: `neededNewSession / triggered`.
