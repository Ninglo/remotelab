# RemoteLab Display v0

For everyday use, reminder meanings and recovery, read [副屏使用说明](USER_GUIDE.md). The system guide renders that same source; this file remains the deployment and interface reference.

This is an instance-local companion for a RemoteLab Server. There is no central
display control plane or separate user-facing display hostname: each RemoteLab
deployment exposes the feature in its existing Settings UI and serves its own
installer, one-time enrollments, device credentials, live dashboard frames,
and device inventory under `/display`.

The generated command deliberately downloads both the installer and agent from
the same Server that issued the enrollment URL, so their protocol versions
match. v0 supports macOS and the Thermalright `0416:5408` display only. A paired Mac can explicitly update its player with the upgrade command below;
automatic client migration is not enabled. Reinstalling from the target Server
remains the recovery path for a damaged installation.

## Optional project module

The v21 detailed editor can display the current Person’s active Sessions grouped
by their existing projects. It reuses titles and status, adds no model calls, and
keeps old modes and applied layouts unchanged until the user selects and applies
the module. See [project module integration and validation](PROJECTS.md).

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

### macOS network proxies

The agent's persistent JPEG and animation downloads use the HTTPS proxy found
by Python's `urllib.request.getproxies()` (environment or macOS system settings),
including proxy bypass rules. An HTTP CONNECT tunnel keeps the device bearer
token inside the target server's verified TLS connection. Loopback HTTP remains
direct. SOCKS-only and HTTPS-to-proxy transports are not supported by this path;
use the proxy application's local HTTP endpoint when required.

Existing paired Macs need the updated `agent.py` and a restart of their existing
LaunchAgent. Updating the server's installer alone does not update an installed
Mac agent; preserve `state.json`, pairing and screen layout during the update.

## Personal Feishu reminders: event-triggered synchronization

Frame playback and dashboard reads only project cached data. Cache expiry,
service startup and calendar reminder deadlines do not query Feishu. There is
no recurring message/calendar poll or token-maintenance interval. Snapshots
are saved privately with mode 0600 and restored without provider requests.

The existing Feishu connector's verified SDK stream writes private change hints
under `display-private/feishu-events/`; the display listens with native filesystem
events. No second Feishu event consumer is started. New-message, read and recall
hints wake message reconciliation; calendar changes wake calendar reconciliation
only. Application realms stay separate. Calendar/read hints carrying recipient IDs
wake only those recipients; IDs are hashed and no message content is copied.
Duplicate events survive connector restarts without producing a new hint.

Received events share the previous request budget: at most one message round per
five minutes and one calendar round per fifteen minutes. A burst within that
budget has one pending event deadline; completing it creates no recurring timer.
New and still-pending messages have details checked, and each message's real read
state determines whether its reminder clears. Failed reads back off; another
actual event or an explicit refresh is required for another attempt.
Calendar deadlines use the saved schedule and local clock without provider calls.

This is **partial event coverage**, not a subscription to the entire user's inbox.
Bot message events and bot P2P read receipts cannot establish all personal unread
changes. Message snapshots older than five minutes are marked stale/unavailable,
not asserted to be a current zero. Calendar snapshots cover the existing roughly
25-hour window and become unavailable after 24 hours without another update.
An explicit Person-scoped refresh can reconcile gaps with
`POST /api/display/feishu/refresh` (or the local administrator endpoint
`POST /v1/people/{personId}/feishu/refresh`). It respects the same request budget.

Registering handlers in code does **not** configure platform subscriptions.
Calendar changes require the application's user event subscription plus the
calendar/user resource subscription described in the [official event guide](https://www.feishu.cn/content/917351528780--3333)
and [schedule-change reference](https://open.feishu.cn/document/server-docs/calendar-v4/calendar-event/events/changed).
The correct application connector must actually be receiving events. An inactive
connector, missing event permission/subscription, or exhausted quota remains a
reported activation gap; the sidecar never replaces it with automatic polling.

Monthly quota exhaustion (`99991403`) stops that application's reads and token
maintenance. The saved rejection survives restart. After an administrator has
restored quota, an explicit refresh with `{ "quotaRestored": true }` clears the
local application gate and verifies it with one bounded round. Routine frame
reads and event hints cannot clear the rejection. Short retries cannot restore
quota. These reads do not call a model.
Actual outgoing requests retain `component: display` in the existing private API
ledger without tokens, bodies, query strings or resource IDs. Use
`scripts/feishu-api-usage.mjs` to measure counts after deployment.

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

## Authenticated studio channels

Cookie-authenticated studio apply, status and reset operations select
`display-studio-preview.json`'s `people[authenticatedPersonId]` entry. The
entry's map key is authoritative, not a browser header or payload. An invalid
entry fails closed. The existing top-level channel remains the default for its
original Person and for legacy token-only links; it is never reassigned.

For an already enrolled device, `node display/configure-person-studio.mjs
--person person_ID --device display_ID --port PORT --source /path/concept-v14`
validates current device ownership and prepares an isolated renderer under
the instance's private config directory. It copies the existing renderer's
three code modules and links only public assets/dependencies/browser libraries;
it does not copy another Person's pairing, layout or private state. Credentials
and registry are saved with mode 0600; setup is idempotent and refuses changes
to an existing pairing/channel. Run that runtime's `preview-server.mjs` through
the instance's service manager with the selected `PREVIEW_PORT`, local
`PREVIEW_DISPLAY_BASE_URL` and `PREVIEW_ADMIN_TOKEN_FILE`. This does not create a
second Feishu consumer, refresh a provider or enable boot startup.

`display/studio-device-sync.js` is the repository-managed client for publishing
to the existing studio's `device-sync.js`. Authenticated apply and detailed
receipt checks both use `/api/display/studio-preview`; old dedicated links
retain `/display/studio-preview`. Bump the page's script cache version when
publishing. Status reports distinguish submission, device download, USB ACK and
physical appearance; only the last still needs on-site observation.

Device download receipts include both static and animated applied frames, scoped
to the current source frame ID. A static download is not evidence of a USB
write or a claim that the physical screen's appearance has been inspected.

Animation protocol v2 first sends a small playable loop. When the device takes
more than four seconds to request its full loop, the sidecar keeps that device
on the cached small loop rather than sending a larger animation ahead of new
clock and task state. A changed source frame still sends a new small loop;
fast links retain the full animation. This choice is per device and frame,
requires no re-pairing, and does not increase provider or model calls.

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

Uploads are limited to 3 MB, 128 frames, 30 seconds, and 307,200 pixels per frame.
The sidecar decodes GIF frames once and sends a complete 1920 × 480 frame on each
device request. The legacy macOS agent reads the frame interval returned by the
server (0.45 seconds for personal content, 8 seconds for the status screen).
The screen is sampled animation rather than full GIF frame-rate playback.
The original GIF and sentence are stored in the private instance config file
`display-personal-content.json` with mode `0600`; this simple-content path remains server-rendered. Studio animation layers can
use the local-playback protocol below.

## 个人待办已退役

副屏不再保存或展示自建个人待办；待办统一使用[飞书任务](../docs/platform-skills/feishu-tasks.md)。旧 `/v1/people/:id/todos` 接口返回 410，状态响应不再包含 `reminderSources.todo`。已有清单文件保留归档，设备配对、画面和其他提醒来源继续沿用原接口。

## Pet companion with clock and weather

The instance-local studio can accept an opt-in version-22 scene containing a pet
action playlist, one supplied sentence, its source timestamp, a local clock and
cached city weather. Install `studio-companion.mjs` as `companion-scene.mjs` and
copy `companion-scene-v2.mjs` beside
that studio's `preview-server.mjs`, then apply `studio-companion.patch` from the
studio root after `git apply --check`. Run the patched `test-preview-stream.mjs`
in its isolated test state and the repository's `tests/test-display-companion.mjs`
before restarting only the affected personal studio renderer.

The existing authenticated apply API and Person pairing remain authoritative.
The existing refresh loop advances the clock and rotates actions once per minute;
weather uses the existing source and its 15-minute cache. The source timestamp
stays fixed and is labeled as a record time, never as a new completion time.
The supplied-sentence variant makes no Session scan or model call. Supplying a new sentence is
separate from its display refresh. Weather failure is shown explicitly.

Payload fields are `version: 22`, `timeZone`, `subject`, `sentence`, `observedAt`
(ISO timestamp with zone), `weatherCity`, `credit`, and `actions`, an array of
`{name, gifBase64}`. Original GIF timing is preserved by the scene; the transport
still applies its own limits. Companion layers opt into `completeLoop: true`:
both the starter and full v2 bundle include the action's first and final poses,
with their interval adjusted to retain its entire duration. Slow links that stay
on a starter therefore still get a complete action. The legacy v2 client accepts
at most 32 frames and at most 500ms per frame; a ten-second action is consequently
about 3 FPS in its full bundle. This is a software transport limit, not a measured
hardware limit. Longer than 16 seconds requires a player update; the opt-in path
rejects such a loop instead of silently cutting it. Existing non-opt-in layouts
retain their timing. Select frames spanning the source video from beginning to
end and preserve its duration; do not substitute a middle excerpt for an action.
The desktop pet's complete action system is not imported by this view.
Validate the rendered bundle, device download and physical playback
separately; a target interval is not a measured USB frame rate.

### Local playback update for paired Macs

Operator handoff: “Update the player on the paired Mac without changing its
pairing, rotation, or layout. Verify local-scene receipt, USB frame timing, and
physical smoothness separately.” When the executor cannot access that Mac,
the unavoidable local step is running its own server's updater in Terminal:

```sh
curl -fsSL 'https://your-remotelab.example/display/upgrade-agent.sh' | sh
```

The updater reads the existing server from `state.json`, downloads its agent,
installs Pillow in the agent's private `vendor` directory, checks JPEG support,
and restarts the existing LaunchAgent. Dependency failures leave the running
player unchanged; validation or launch failures restore the previous agent and
vendor directory. Pairing and layout are preserved.

With Pillow available, the agent requests
`application/vnd.remotelab.display-scene+json;v=3;id=<frameId>;assets=<hash>.<hash>`
on its existing authenticated frame URL. The response has a background PNG,
layer geometry and original small GIF assets, keyed by their SHA-256 prefix.
The server omits assets already in the agent's memory cache and returns 304 for
an unchanged scene. The Mac composites the complete loop locally and submits
JPEG frames to the existing USB worker at a target 100ms interval. Ten-second
pet exports can retain 101 frames instead of the old 20/32-frame samples.
Asset cache lasts until the player restarts. Clock refresh downloads only the
background after the current GIF is cached; no model call is involved.

Source GIFs retain the 3 MB, 128-frame, 30-second and 307,200-pixel limits.
A composed local loop must fit 128 playback frames (12.8 seconds at 10 FPS);
longer loops fail explicitly instead of truncating. A failed scene refresh
keeps the last verified local loop. Old clients continue using v2 unchanged.
For v22 playlists, apply `studio-local-playback.patch` after the companion
patch and recopy `studio-companion.mjs`: this allows a 13 MB request containing
three full actions and persists the scene only when the minute changes.
Validate with `tests/test-display-local-scene.py` (Pillow), the sidecar and main
route tests. Logs distinguish `local_scene_loaded` from USB heartbeat timing;
the configured 10 FPS remains a target until measured on the actual display.

When exporting transparent pet videos, sample continuous RGBA PNG frames first,
then use `display/export-pet-gif.py` (Pillow required) with the matching
`--duration-ms` and optional `--crop LEFT TOP RIGHT BOTTOM`. It reserves palette
index 255 for transparency in every frame. Direct automatic RGBA-to-GIF export
can change the transparent palette index between frames and produce flashing
opaque rectangles. Check all frames through the actual GIF decoder and rendered
JPEG bundle, including transparent corners, rather than inspecting a single
preview. `tests/test-display-pet-gif.py` covers changing palettes, moving artwork,
opaque black details and preserved timing. This export fix requires new assets,
not a USB agent or pairing change.

### Complete action library and useful text

The opt-in `design: "companion-v2"` scene uses the same v22 apply route and v3
Mac player. The v2 layout places the original, unmirrored character against the
right edge, its speech bubble in the center, and Beijing time/weather on the
left. Only the speech-tail geometry is mirrored; text and GIF bytes are not.
Action names, library counts and asset credits stay in metadata rather than the
screen footer. Quiet observations render no speech bubble by default. A Person
can opt their preview into `casualSpeech: true`: quiet periods then show a short
daily phrase, changing every five minutes through the existing scene refresh.
Work observations and rest reminders take precedence. Casual phrases have no
source timestamp or footer, make no claims about work status, and do not call
a model. This option changes only the background text; the action playback ID
and time axis stay intact. Existing previews remain unchanged unless opted in.
Apply `studio-companion-library.patch` after the patches above;
copy `companion-library.mjs`, its `vendor/dsh-pet/` directory,
`companion-scene-v2.mjs` and the updated
`studio-companion.mjs` (as `companion-scene.mjs`) into that personal studio.
Run the patched stream test before restarting the renderer. Existing supplied
v22 scenes retain their original layout and validation.

Install an operator-owned export manifest into the studio's private directory:

```sh
node display/install-companion-library.mjs /absolute/export/manifest.json \
  /absolute/studio/concept-v14/private/companion-libraries library-v1
```

The installer verifies hashes and decodes every GIF before an atomic install.
A canonical manifest has `version: 1`, `id` and `actions` with `name`, `category`,
relative `file`, SHA-256, frame count and duration. Keep licensed personal assets
private; the repository carries the loader, not the character library. A new
library ID leaves the previous set intact for rollback.

For a library scene, replace inline `actions` with `libraryId`, set
`design: "companion-v2"` and optionally `liveObservation: true`. Keep the supplied
fallback `subject`, `sentence`, explicitly zoned `observedAt`, credit, Beijing
weather and `Asia/Shanghai` time fields. The server loads only the selected GIF
and plays it once. The Mac agent (player version 5) keeps the final pose after
its full duration and USB acknowledgment, then reports `playbackState: "ended"`
with the action's `playbackId` through the existing heartbeat route. The studio
selects a new action only for a matching receipt from its playback device.
Clock, weather and text updates retain that ID and do not restart the action.
A delayed download keeps the finishing pose visible; there is no timed fallback
that advances the action without a device receipt. Earlier agents still loop
and need the existing `upgrade-agent.sh` update before this behavior works.

Set `behavior: "dsh-pet"` in the reviewed export/installed manifest to use the
vendored upstream picker and default animation weights (see
`vendor/dsh-pet/README.md` for revision/license). The adapter uses upstream's
fixed-position option and left-facing orientation: idle keeps its original
10% probability, while the remaining probability chooses an original weighted
category. The picker excludes the current action when that pool has alternatives;
a single idle candidate can repeat, as in the original. Interaction and event
assets remain installed/addressable but are not randomly mixed into the ambient
chain. Other libraries select from their installed names, excluding the current
name when possible. This is not an all-assets-once permutation.

By default the paired device supplies completion receipts. If the same Person's
screen is physically attached to another enrolled device, an operator can set
`playbackDeviceId` in the private studio pairing file to that owned device's ID.
This only selects the receipt source; it does not change pairing or expose another
Person's data. Existing device-scoped status grants remain scoped as before.

An administrator-only `GET /v1/people/:personId/companion-observation` reuses the
existing summary reader, scoped to that Person's initiator identities, with a
30-second cache. It does not read full conversations or invoke a model. Active
waiting entries can show `needsFromUser` as “待确认记录”; waiting also includes
resource queues, so this is not a claim that the current run awaits a human.
Idle, nonqueued entries can show `knownConclusions` from the last 15 minutes.
Both kinds must contain an explicit reader action, such as a request to confirm,
provide or choose something, or an invitation to view, try or accept a result.
Generic capabilities, preservation notes and test-passed statements alone do
not qualify. This conservative text gate preserves whole sentences and can
omit useful messages that do not express a next step; it adds no AI classifier.
Archived/internal entries, stale (>=24h for requests), unsafe metadata,
long (>60-character) and process-only items are excluded as whole items.
Summary text is attributed to “对话更新” using `lastAssistantMessageAt`; this is
not a claim's creation time or an independent verification of completion.

Per-Person dedupe state persists privately across restarts. New results dwell
for a minute; unresolved requests repeat no sooner than 30 minutes. With no new
item the pet stays quiet. A neutral rest reminder can appear after 90 minutes
between 09:00 and 21:00 Beijing time; it does not claim to measure actual work.
Text changes refresh the background independently of the action minute; a
missing text source leaves the pet quiet; stale weather is shown explicitly. The display adds no model
calls. Reuse of summaries does not replace their source task's verification.
