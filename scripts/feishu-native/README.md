# Feishu Native Trial / Web 1.2 + Mac Live parity (revision 9)

Ask the maintaining agent: “Update the existing isolated Feishu Native Trial
with the verified Web 1.2.0 component bundle and the existing Mac Web Live capabilities. Restore the same-account read-only status source, including group boards and usage; never replace it with a fresh personal-login requirement. Keep the official App and profile
untouched. Check the running test copy before replacing files, retain the first
working backup, and verify navigation, settings, account isolation and actual
personal connections. Reuse an authenticated browser only when its Person
matches the requester; otherwise leave the login step pending.”

This adapter supports the existing macOS Feishu **8.0.3** trial prepared with
bundle identifier `dev.remotelab.feishu-native-trial` and isolated `RlfeTrial`
profile. It is not an installer for an arbitrary official Feishu application.
It does not enable DevTools or alter the machine's debugging policy.

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

The same four navigation components are mounted **inside the message-list
renderer**. The outer official native navigation remains intact; this is not
pixel-identical placement. Index/thinking run in that renderer. Native-window
layout, meetings, notifications, global shortcuts and distribution updates are
separate from Web component verification. Voice input was not in Web 1.2.0 and
is not added by this adapter.

Validation:

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
| Four navigation entries and latest report | Original components and source quick links | Native rail remains inside the message-list renderer |
| Personal Index/thinking and reply/model settings | Original components + personal grant broker | Real content/read/write still needs the requester's login |
| Sorting, reading, pet and preference export/import | Original components retained | Native selector/model prerequisites still apply; no blanket daily-use claim |
| Voice, meeting media, global shortcuts, installer/upgrades | Not added by this adaptation | Separate work/real-device acceptance needed |

A screenshot cannot be inferred from DOM verification. The helper's real
`native-asset-status.json` includes rendered Session labels, native header IDs,
board/usage/artifact status and saved-preference state for direct comparison.

For rollback, exit only the test App, restore its messenger archive and bridge
from the corresponding `before-native-v8` or `before-native-v9` backup, re-sign the two modified trial bundles, verify their
signature, and launch with the original trial launcher. Preserve
`native-v8-storage.json` for recovery; do not copy its grants elsewhere.

The updater uses graceful App exit and snapshots the isolated profile on the Mac when a restored editor draft is present. It never clears or sends drafts. Profile snapshots contain private login data and must stay in the private local trial directory.
