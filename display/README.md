# RemoteLab Display v0

This is an instance-local companion for a RemoteLab Server. There is no central
display control plane: each RemoteLab deployment serves its own settings page,
installer, one-time enrollments, device credentials, live dashboard frames,
and device inventory.

The generated command deliberately downloads both the installer and agent from
the same Server that issued the enrollment URL, so their protocol versions
match. v0 supports macOS and the Thermalright `0416:5408` display only. Updates,
cross-version compatibility, and automatic migration are intentionally out of
scope; reinstalling from the target Server is the recovery path.

## Server

```bash
export REMOTELAB_CHAT_BASE_URL=http://127.0.0.1:7696
export REMOTELAB_DISPLAY_PUBLIC_BASE_URL=https://display.example.com
node display/server.mjs
```

The service listens on `127.0.0.1:8792` by default. The administrator URL is
written to stdout on startup and uses a private token stored at
`$REMOTELAB_CONFIG_DIR/display-admin-token` (or the default RemoteLab config
directory). The settings page generates a ten-minute, one-use command such as:

```bash
curl -fsSL 'https://display.example.com/install.sh' | sh -s -- \
  'https://display.example.com/v1/enroll/rld_enroll_...'
```

## Security boundary

- The enrollment link is single-use and expires after ten minutes.
- The installed agent receives a device-only credential; it cannot query the
  RemoteLab API or connector data.
- The display service authenticates to its colocated RemoteLab privately and
  projects only dashboard state into a rendered frame.
- State and administrator/device credentials are stored with mode `0600`.
- The local agent initiates every network connection and exposes no listener.

The conservative USB framing in `agent.py` is derived from the MIT-licensed
`thermalright-display-bridge` project in this workspace.
