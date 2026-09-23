# RemoteLab Display v0

This is an instance-local companion for a RemoteLab Server. There is no central
display control plane or separate user-facing display hostname: each RemoteLab
deployment exposes the feature in its existing Settings UI and serves its own
installer, one-time enrollments, device credentials, live dashboard frames,
and device inventory under `/display`.

The generated command deliberately downloads both the installer and agent from
the same Server that issued the enrollment URL, so their protocol versions
match. v0 supports macOS and the Thermalright `0416:5408` display only. Updates,
cross-version compatibility, and automatic migration are intentionally out of
scope; reinstalling from the target Server is the recovery path.

## Server

```bash
export REMOTELAB_CHAT_BASE_URL=http://127.0.0.1:7696
node display/server.mjs
```

The companion listens on `127.0.0.1:8792` by default. The main RemoteLab server
proxies its public protocol under `/display`; its internal administrator token
is stored at `$REMOTELAB_CONFIG_DIR/display-admin-token` (or the default
RemoteLab config directory). The authenticated Settings page generates a
ten-minute, one-use command such as:

```bash
curl -fsSL 'https://your-remotelab.example/display/install.sh' | sh -s -- \
  'https://your-remotelab.example/display/v1/enroll/rld_enroll_...'
```

## Security boundary

- The enrollment link is single-use and expires after ten minutes.
- Enrollments and device inventory are bound to the signed-in RemoteLab Person.
- A device frame contains only Sessions initiated by identities linked to that Person.
- The installed agent receives a device-only credential; it cannot query the
  RemoteLab API or connector data.
- The display service authenticates to its colocated RemoteLab privately and
  projects only dashboard state into a rendered frame.
- State and administrator/device credentials are stored with mode `0600`.
- The local agent initiates every network connection and exposes no listener.

The conservative USB framing in `agent.py` is derived from the MIT-licensed
`thermalright-display-bridge` project in this workspace.

## Signal-screen pilot

The existing pairing, Person boundary, frame URL, and Mac USB agent stay unchanged. Set
`REMOTELAB_DISPLAY_RENDER_MODE=signals` on the display sidecar to replace the fixed
dashboard with an official one-signal-at-a-time theme. Without that setting the
classic dashboard remains available for rollback. The built-in RemoteLab source
currently reports running/queued Sessions, recent delivery-issue records, and
results-to-browse. “Results to browse” is a heuristic **note**, not a confirmed
request for user action. No Feishu or evaluator source is installed by this pilot.

Trusted local adapters may `PUT /v1/people/{personId}/sources/{sourceId}` to the
loopback sidecar using its administrator bearer token. This endpoint is not
publicly proxied. Each update replaces one source's full snapshot and must use
a monotonically increasing `sequence` that survives adapter restarts. A source
may withdraw all its signals by sending `signals: []`. An adapter should send
only short text safe for a visible screen:

```json
{
  "schemaVersion": 1,
  "sequence": 12,
  "label": "Evaluation",
  "observedAt": "2026-09-23T10:00:00+08:00",
  "validUntil": "2026-09-23T10:05:00+08:00",
  "signals": [{
    "id": "run-42-decision",
    "phase": "attention",
    "urgency": "high",
    "title": "评测等待确认",
    "summary": "异常任务已暂停，请到评测页面决定下一步。",
    "subject": "RoboDojo 评测",
    "destination": "去评测页面处理",
    "occurredAt": "2026-09-23T09:59:00+08:00",
    "expiresAt": "2026-09-23T10:30:00+08:00",
    "evidence": "confirmed"
  }]
}
```

`phase` is `attention`, `incident`, `upcoming` (requires `dueAt`), `result`,
`progress`, or `note`. `evidence` is `confirmed` or `source_reported`; the
official theme labels unverified attention as “待核对”. Both source and signal
expiration suppress stale claims. The official scene selects one fresh signal
in that phase order, shows stale data as “状态未更新”, and keeps RemoteLab counts in
a small side panel. `GET /v1/people/{personId}/status` and `preview.png` expose
the Person-scoped snapshot and preview to the local administrator only.

`REMOTELAB_DISPLAY_THEME_MODULE=/absolute/path/theme.mjs` selects a locally
trusted ES module exporting synchronous `renderTheme(snapshot, { metrics,
nowMs })` that returns a 1920×480 SVG string. Custom theme code executes in the
sidecar process and must not be installed from untrusted uploads. The sidecar
converts SVG to PNG; the Mac agent still periodically pulls a full frame and
sends it over USB. Run `node display/render-previews.mjs <output-directory>` to
inspect official progress, confirmed-attention, and stale states before
activating the pilot.
