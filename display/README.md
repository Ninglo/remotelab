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

Applied display layouts persist until the user replaces them or explicitly
returns to the default display. They do not expire after 24 hours, including
layouts saved by older versions, and survive sidecar restarts. The
`preview-frame` endpoint retains its protocol name and returns `expiresAt: null`.
Short-lived enrollment links and time-sensitive reminder signals keep their
own expiration rules.

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

## Personal Feishu reminder refresh

Frame playback and dashboard reads reuse one Person's Feishu snapshot. Personal
message discovery and read-state reconciliation run at most once every five
minutes; calendars refresh every fifteen minutes. Existing cached message
classification is reused, while new and still-pending messages have their
details checked. Reading or dismissing reminders does not force another search.
The message search still covers the last 24 hours so marking a known message
unread can restore its reminder; it is not an all-account event subscription.
Bot message events do not cover the whole user's inbox or all read receipts.

An unsuccessful refresh is cached too, with exponential backoff. Provider
errors pause other message/calendar reads for the same application, honoring
`Retry-After` when it requires a longer pause. The normal reminder delay is up
to five minutes; failures may extend it. Monthly quota exhaustion (`99991403`)
stops that application's message/calendar reads until quota is restored and
the sidecar is restarted; short automatic retries cannot restore quota.
These reads do not call a model.
Actual outgoing Feishu requests are recorded with `component: display` in the
existing private API ledger without tokens, bodies, query strings or resource
IDs. Use `scripts/feishu-api-usage.mjs` to measure real counts after deployment.

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

## Waiting in the detailed studio

Display metrics use the same Session status projection as the chat sidebar:
`running` excludes a live run marked waiting, and `waiting` includes visible
between-turn waiting Sessions. A new executing, queued or compacting turn takes
precedence over the previous workflow label. Waiting and results to browse stay
separate, and these counts do not assert urgency or user acceptance.

The instance-local v14/v21 studio predates repository-managed display assets.
`display/studio-waiting.patch` records its focused update (adapter, refresh
fingerprint, four overview counts, quiet gold styling, cache version and stream
regression). Apply it from that studio's root after `git apply --check`, and
verify `node concept-v14/test-preview-stream.mjs` in its isolated test state.
Publish the updated v21 `app.js`, `v21.css` and `index.html` to that instance's
existing studio pages, then restart only its preview renderer. Preserve pairing,
applied settings, theme, reminders and animation. Older adapters without a
waiting count retain the original three-column overview rather than claiming
zero. Confirm the target device's new frame receipt and continuing USB ACKs;
the physical appearance still needs on-site observation.

`display/studio-queue-visibility.patch` follows the waiting update. It hides the
queue count and queue wording when there are no queued requests, and restores
them when requests are waiting to start. The remaining overview counts fill the
available width. Apply it from the studio root after `git apply --check`, verify
zero and positive counts in overview and running modes, and follow the same
publication and device-receipt checks above. Pairing and applied settings stay
in place.

## Personal GIF and sentence

In **Settings → Side display**, each signed-in Person can upload a GIF and save
one sentence. Their paired displays then show the animation beside that sentence.
The same Settings section links to the detailed display editor at
`/public-pages/secondary-display-studio/index.html`. The simple GIF editor remains
available. Applying a detailed layout gives its live frame priority; saving a
simple GIF or restoring the status screen stops that detailed preview stream so
the selected simple or status view can take over immediately.
The settings panel previews the GIF before saving; **Restore status screen**
removes the personal content and returns to the existing signal or classic view.
Content belongs to the signed-in Person, so another Person's display and editor
remain separate. One Person's paired displays share the same content in this MVP.

Uploads are limited to 3 MB, 48 frames, 30 seconds, and 307,200 pixels per frame.
The sidecar decodes GIF frames once and sends a complete 1920 × 480 frame on each
device request. The new macOS agent reads the frame interval returned by the
server (0.45 seconds for personal content, 8 seconds for the status screen).
The screen is sampled animation rather than full GIF frame-rate playback.
The original GIF and sentence are stored in the private instance config file
`display-personal-content.json` with mode `0600`; no GIF is sent to the USB agent.
