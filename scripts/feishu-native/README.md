# Feishu Native Trial / Web 1.2 + Mac Live parity (revision 15)

Ask the maintaining agent: “Update the existing isolated Feishu Native Trial
with the verified Web 1.2.0 component bundle and the existing Mac Web Live capabilities. Restore the same-account read-only status source, including group boards and usage; never replace it with a fresh personal-login requirement. Keep the official App and profile
untouched. Check the running test copy before replacing files, retain the first
working backup, and verify navigation, settings, account isolation and actual
personal connections. Reuse an authenticated browser only when its Person
matches the requester; otherwise leave the login step pending.”

This adapter supports the existing macOS Feishu **8.0.3** trial prepared with
bundle identifier `dev.remotelab.feishu-native-trial` and isolated `RlfeTrial`
profile. The separate [8.1.17 Apple Silicon preview installation flow](INSTALL.zh-CN.md)
clones an exact verified official build into a new isolated trial. It is not an
installer for arbitrary Feishu versions; a different archive digest is refused.
It does not enable DevTools or alter the machine's debugging policy.

`bootstrap.sh` is the one-command entry: it verifies the exact source archive,
fetches SHA-256-pinned Node and portable Python into a private user directory,
and invokes `install-preview.py`. No system runtime, Homebrew, sudo or developer
tools are required. `package-cli.py BUILD FONT_LICENSE OUTPUT PUBLIC_BASE`
validates the two runtime archives already present in OUTPUT/runtime, builds the
reviewed code/assets ZIP and fills the bootstrap's release pins. Publish OUTPUT
as a static directory and verify the complete public command on a Mac before
handing it out. Runtime origins and hashes are recorded in release.json;
upstream licenses remain inside their runtime archives. The release includes 1 MiB
content-addressed chunks with hashes pinned in the bootstrap. Four bounded
downloads run at a time using macOS system Bash 3.2-compatible array handling; verified chunks survive errors and subsequent runs. The
public mirror is primary; upstream byte ranges are fallback only. Corrupt chunks,
520 responses and truncated transfers cannot be installed. The entry command
retries HTTP/network failures, downloads the complete script before execution,
and preserves already complete runtime files from the previous installer.
Old failed whole-file transfers were deleted by that version and are unrecoverable.

`install-preview.py` validates the official version, archive hash, signature and
package checksums. It creates its own profile, injects the reviewed runtime with
`archive_patch.py`, rebuilds signatures and checks original source hashes. An
identical installed runtime, helper build hash and archive can be reopened without overwriting
account data or preferences; verified older standalone installations can upgrade after the test App exits; partial or unknown installations are preserved and refused. A lock prevents concurrent bootstrap installations. Failure never
changes the official App. The upgrade signs a staged clone before replacing the isolated App, keeps a local rollback copy, restores old files if replacement fails, and never replaces the profile or account settings.
`package-preview.py` packages only reviewed code/assets with a checksum manifest;
no official App, profile, local capability or connection record is distributed.

The standalone package does not create the Mini's already-authorized read-only
source on another machine. Settings → 连接状态同步 now opens the normal personal grant page. The helper uses that exact account/origin token to subscribe to visible topic IDs and the native chat header’s group ID. Group boards and Session state come directly from the server. The topic endpoint also projects scoped cumulative/context usage, current quota display fields and verified HTML artifacts from the configured registry. It never returns account credentials or other Sessions’ histories. Missing telemetry stays unknown.
Personal workspace/settings retain the real login/grant flow. Installed and
signature-verified does not mean all 8.1.17 logged-in components or meeting media
have been verified.

`install-launcher.py` adds 飞书增强版.app to the user's Applications directory,
using the installed private Python. It no longer compiles Swift or writes a new
Desktop shortcut. Existing shortcuts remain valid. Cold starts invoke the exact
isolated binary once with its profile argument; reopening an already running
exact-path process uses LaunchServices without restarting it. The original
launcher is backed up locally. The bridge and process observer inherit the
explicit test root for isolated verification.

On the existing Mac Live setup, Session and group **data** already update live.
Enhancement **code** remains embedded in the trial archive. Standalone users quit the enhancement App and rerun the same installation command; `upgrade-preview.py` stages and verifies the update while preserving the profile. The existing Mini flow continues to use `update.py`. Neither the new shortcut nor the existing
data stream provides automatic code hot updates. A future code updater would
need a verified version manifest, atomic installation and rollback; in-process
reload additionally needs complete component cleanup and draft preservation.

Revision 15 uses the maintained personal workspace component from
`static/feishu-personal-workspace.js`, recorded by its own hash. Index is a
plain persistent private chat with a bottom composer. thinking reads explicit
project-memory sections and recent personal work before suggesting next steps;
daily reports and todos remain supporting sources. Missing memory is shown, not
replaced with parent-project prose. See [personal workspace](../../docs/feishu-personal-workspace.md).

Required inputs: the verified Web 1.2.0 extension directory, access to the
existing trial, and the reviewed Mac Web Live extension directory. A personal
RemoteLab login is needed only for personal settings/Index/thinking grants.
Both source directories are read-only.
`build.mjs WEB_SOURCE OUTPUT MAC_LIVE_EXTENSION` records the exact
content and extra-component SHA-256 values and produces a template containing no credentials. Place that
verified output at the trial root's `v8-build`, then run `install.py` on the Mac
once. It refuses a running App or an unknown resource baseline. `update.py`
updates an already installed trial after checking the previous digest and that
settings, personal views and meetings are not active. Do not retry an uncertain
write before checking the deployment record.

`adapter.js` supplies the native environment and list selectors. `loader.js`
uses the native account API, a fixed local broker, and the original Web
components. `bridge.cjs` binds only `127.0.0.1:19342`; the private capability
stays in the existing trial directory. It exposes fixed operations and
per-account storage, not a general network or filesystem proxy. Account
connections use the normal server grant pages and independent settings,
workspace capabilities. No web cookies or owner token are copied.

`live-source.cjs` restores the already-authorized Web Live read-only projection.
Run `connect-live-source.cjs` on the Mac only after both known windows are
running: it verifies the existing browser account equals the native Passport
account and records that identity locally. A different saved binding is refused.
It does not create a personal grant or make an unrelated account authorized.
The source files remain in `Feishu Web Live`; do not copy credentials or create
a second upstream consumer. The native broker watches projection changes and
checks the existing controller's heartbeat/liveness and browser account. It
filters entries to visible/native-header IDs, boards to matched groups and
artifacts to matched Sessions. It forwards the original RL state unchanged.
Account changes clear the projection; lost source/transport displays “未同步”.
A fresh upstream snapshot is required after upstream loss. The renderer uses
15-second helper heartbeats, a 45-second deadline and bounded automatic
reconnect, then waits for focus/network after the retry budget expires.

Group boards and usage derive chat identity from the committed native header;
the separate list renderer supplies native navigation with a completion receipt.
Never guess Session identity from the displayed name. Group “已完成” remains
an existing work-record summary, distinct from the Session's execution label.

The revision 8 upgrade accidentally suppressed the existing local projection by
activating the ordinary extension grant-only stream. Its navigation/settings
checks did not establish live state parity. Revision 9 keeps the Live guard and
restores the original source instead of requiring a new status login.

The same four navigation actions and an explicit Settings button occupy a labelled experimental section inside the existing message-group sidebar. The message root is not shifted; the official outer navigation remains intact. A settings-only fallback remains accessible when the group sidebar is folded. Widths 280/320/448/768/1280 px are checked. `topic-view.js` targets the native title and digest rows separately: the native title uses a three-column grid, so injecting the summary next to the title truncates both the name and status. A recycled row restores native text before paint; unchanged projections do not rewrite its DOM. Unknown structures retain the native text. Browser component acceptance does not establish actual personal Mac visual acceptance. Index/thinking run in that renderer. Native-window
layout, meetings, notifications, global shortcuts and distribution updates are
separate from Web component verification. Voice input was not in Web 1.2.0 and
is not added by this adapter.

Validation:

- `python3 tests/test-feishu-native-download.py` (520, truncation, corruption, resumed cache and Range fallback)
- `python3 tests/test-feishu-native-launcher.py` (one cold start, preserved running App, private runtime/root)
- `python3 tests/test-feishu-native-upgrade.py` (replacement failure restores old App and helper)
- `node tests/test-feishu-native-topic-source.mjs` (standalone grant, groups, account isolation and stale/recovery)
- `python3 tests/test-feishu-native-installer.py` (archive entry integrity and duplicate injection refusal)
- `node --test tests/test-feishu-web-settings.mjs tests/test-feishu-web-topics.mjs tests/test-feishu-personal-workspace.mjs`
- `node tests/test-feishu-native-live-source.mjs` (scope, account changes, live transitions, stale snapshots and recovery)
- `node tests/test-feishu-native-bridge.mjs` (uses local port 19342 temporarily)
- `node tests/test-feishu-native-browser.mjs PLAYWRIGHT_MODULE CHROMIUM RUNTIME_TEMPLATE ARTIFACTS_DIR`
- The local authenticated `/verify` operation runs the existing component
  actions on the actual Mac trial, restores temporary settings and aliases,
  and saves `native-v8-verification.json`. It never sends a chat message.

Current capability audit:

| Capability | Native integration | Acceptance boundary |
| --- | --- | --- |
| Themes, fonts, settings, aliases | Original Web components | Real Mac save/restore and alias checks |
| Topic name, summary, Session state | Existing RL source restored | Real visible rows match source; isolated transition/stale/reconnect tests |
| Group board | Original paired-group data + native header adapter | Actual Claude Tag board mounted; group totals are existing source records |
| Usage/context/quota | Original Live component restored | Exact native Session identity; retain the user's display switch |
| Message-contained HTML artifacts | Original Live component included | Only verified delivery anchors; absence of a real artifact is not a display pass |
| Four navigation entries and latest report | Original components and source quick links | Experimental section inside the existing message-group sidebar |
| Personal Index/thinking and reply/model settings | Original components + personal grant broker | Real content/read/write still needs the requester's login |
| Sorting, reading, pet and preference export/import | Original components retained | Native selector/model prerequisites still apply; no blanket daily-use claim |
| Desktop launcher | Stable shortcut to existing trial, activates running window | Private-runtime launcher; no code hot update |
| First install on another Apple Silicon Mac | Exact official 8.1.17 build, isolated clone/profile, checksummed preview package | Personal grant and logged-in functional acceptance remain separate |
| Voice, meeting media, global shortcuts, distribution upgrades | Not added by this adaptation | Separate work/real-device acceptance needed |

A screenshot cannot be inferred from DOM verification. The helper's real
`native-asset-status.json` includes rendered Session labels, native header IDs,
board/usage/artifact status and saved-preference state for direct comparison.

For rollback, exit only the test App, restore its messenger archive and bridge
from the corresponding `before-native-v8` or `before-native-v9` backup, re-sign the two modified trial bundles, verify their
signature, and launch with the original trial launcher. Preserve
`native-v8-storage.json` for recovery; do not copy its grants elsewhere.

The updater uses graceful App exit and snapshots the isolated profile on the Mac when a restored editor draft is present. It never clears or sends drafts. Profile snapshots contain private login data and must stay in the private local trial directory.

Standalone server setup: the existing feishu-web-topics.json binding/group configuration may include an absolute artifactsFile path to the existing schema-1 HTML registry. The adapter reuses that registry, checks source hashes and exact Session/chat/root identity, and exports only verified visible-topic artifacts. Usage comes from the shared ledger and usage events (metadata only, bounded initial backscan); quota exports percentages/timestamps only. State updates retain normal invalidations; telemetry refreshes at the existing 60-second cadence. Tests: tests/test-feishu-web-topic-details.mjs.

Launcher repair 2 uses proxy-free, redirect-free authenticated loopback checks. It removes the bind-only port probe (TIME_WAIT is not a listener), waits for the exact new helper PID before launching the App, and recovers only a same-user, exact-command helper from this installation. A live App with a healthy helper is focused; a disconnected App can reconnect without losing its input. Repeating the installer refreshes the launcher even when the r11 runtime hash is unchanged.

Revision 12 mounts the experimental actions and an explicit settings button in `.a11y_feed_filter_list` (8.1.17 message groups), with the legacy `.feed-left-menu-list` fallback. It does not alter the separate outer native rail or shift the message root. A settings-only fallback remains reachable when groups are folded. Topic subscriptions retain up to 200 recently visible IDs/groups, keep one active and one pending connection, and replace the active stream only after a verified snapshot. Account/grant changes and authorization failures clear retained data; real outages show unsynced. All returned Session status labels, including idle, remain visible.

Revision 13 keeps the settings/version footer below four individually marked experimental entries, with the shared UI font token across shadow roots. Topic grants may explicitly opt into `topicReadAck`; old grants remain read-only. The native renderer waits for the currently opened topic, committed zero-unread preview, message timestamp at least as new as the observed result, and matching active chat before acknowledging exactly `resultAt`. Server-side acknowledgements only advance the existing RemoteLab review timestamp; concurrent newer results remain unread. Mapping is verified independently and unknown rows are never guessed from titles.

Revision 14 replaces native per-feature popups with a single same-tab confirmation and fixed loopback fragment callback. All three existing, account-scoped grants are issued in one durable transaction; the helper validates every grant and common Person before storing any. Valid complete bundles are reused; rejected/expired grants require confirmation. Grants are never included in server request URLs. Pending native connection attempts reuse the current confirmation. Verified topic mappings also supply their parent group to board selection when native header group IDs are absent; unknown/private/unmapped topics do not widen projection. User-machine board visibility remains separate from fixture acceptance.
