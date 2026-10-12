# Feishu Native Trial / Web 1.2 parity

Ask the maintaining agent: “Update the existing isolated Feishu Native Trial
with the verified Web 1.2.0 component bundle. Keep the official App and profile
untouched. Check the running test copy before replacing files, retain the first
working backup, and verify navigation, settings, account isolation and actual
personal connections. Reuse an authenticated browser only when its Person
matches the requester; otherwise leave the login step pending.”

This adapter supports the existing macOS Feishu **8.0.3** trial prepared with
bundle identifier `dev.remotelab.feishu-native-trial` and isolated `RlfeTrial`
profile. It is not an installer for an arbitrary official Feishu application.
It does not enable DevTools or alter the machine's debugging policy.

Required inputs: the verified Web 1.2.0 extension directory, access to the
existing trial, and the requester's authenticated RemoteLab browser session.
The Web directory is read-only. `build.mjs WEB_SOURCE OUTPUT` records the exact
content SHA-256 and produces a template containing no credentials. Place that
verified output at the trial root's `v8-build`, then run `install.py` on the Mac
once. It refuses a running App or an unknown resource baseline. `update.py`
updates an already installed v8 after checking the previous digest and that
settings, personal views and meetings are not active. Do not retry an uncertain
write before checking the deployment record.

`adapter.js` supplies the native environment and list selectors. `loader.js`
uses the native account API, a fixed local broker, and the original Web
components. `bridge.cjs` binds only `127.0.0.1:19342`; the private capability
stays in the existing trial directory. It exposes fixed operations and
per-account storage, not a general network or filesystem proxy. Account
connections use the normal server grant pages and independent settings,
workspace and topics capabilities. No web cookies or owner token are copied.

The same four navigation components are mounted **inside the message-list
renderer**. The outer official native navigation remains intact; this is not
pixel-identical placement. Index/thinking run in that renderer. Native-window
layout, meetings, notifications, global shortcuts and distribution updates are
separate from Web component verification. Voice input was not in Web 1.2.0 and
is not added by this adapter.

Validation:

- `node --test tests/test-feishu-web-settings.mjs tests/test-feishu-web-topics.mjs tests/test-feishu-personal-workspace.mjs`
- `node tests/test-feishu-native-bridge.mjs` (uses local port 19342 temporarily)
- `node tests/test-feishu-native-browser.mjs PLAYWRIGHT_MODULE CHROMIUM RUNTIME_TEMPLATE ARTIFACTS_DIR`
- The local authenticated `/verify` operation runs the existing component
  actions on the actual Mac trial, restores temporary settings and aliases,
  and saves `native-v8-verification.json`. It never sends a chat message.

For rollback, exit only the test App, restore its messenger archive and bridge
from `before-native-v8`, re-sign the two modified trial bundles, verify their
signature, and launch with the original trial launcher. Preserve
`native-v8-storage.json` for recovery; do not copy its grants elsewhere.
