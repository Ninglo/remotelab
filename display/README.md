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
