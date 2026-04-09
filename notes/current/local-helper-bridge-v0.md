# Local Helper Bridge V0

Status: proposed current execution note as of 2026-04-09

Companions:

- `docs/project-architecture.md`
- `docs/external-message-protocol.md`
- `notes/current/instance-scoped-connectors.md`
- `notes/current/product-mainline.md`
- `notes/current/user-feedback-log.md`

## Goal

Add a minimal local helper bridge so a RemoteLab session can discover and read relevant files from a trusted user's own machine, then selectively stage useful files into the normal session attachment flow.

This is an internal-first / trusted-user capability, not a general end-user launch.

## Product framing

This is **not** "remote desktop control."

The V0 product truth is:

- a linked local helper process can expose a small read-only filesystem surface to one RemoteLab workspace
- the model can use that surface to find likely-relevant files
- the helper can stage selected files into the existing RemoteLab asset pipeline
- the local computer stays an implementation detail, but the helper still enforces explicit local roots and a read-only protocol

## Main decisions

### 1. Cross-platform architecture, Mac-first validation

Cross-platform matters because trusted internal validation may happen on macOS before any real Windows rollout.

So the rule should be:

- write the helper as a cross-platform Go binary
- validate the full end-to-end loop on macOS first if that is where the operator machine exists
- keep Windows as a first-class target in code structure and path semantics
- do not spend V0 time on polished cross-platform packaging, signing, or installer UX

### 2. Go over Rust for V0

Use Go for the helper because V0 is mostly:

- filesystem access
- HTTP client behavior
- long-poll / heartbeat loops
- JSON encoding
- file upload streaming

The repo currently has no Go or Rust subtree, so the cheapest new-language addition is the one that gets to a reliable single-binary helper fastest.

### 3. Keep the protocol tiny

V0 should expose only these filesystem primitives:

- `list`
- `find`
- `stat`
- `read_text`
- `stage`

Do not add raw write, rename, delete, execute, or desktop-automation commands.

### 4. Use HTTP long-poll, not a new realtime stack

RemoteLab's current architecture treats HTTP as the canonical state path and WebSocket as an invalidation hint.

The helper should follow the same shape:

- authenticate once during pairing
- long-poll for commands
- POST results back
- upload staged files through the existing file-asset flow

This keeps V0 aligned with current architecture and avoids introducing a second "special realtime lane" too early.

## End-to-end V0 flow

1. Owner opens a normal RemoteLab session and requests a local helper pairing code.
2. RemoteLab creates a short-lived pairing token bound to that session or workspace.
3. The user runs:

```bash
remotelab-helper pair --server https://host --code XXXX
```

4. The helper exchanges the code for a durable `deviceId` and `deviceToken`, then writes local config.
5. The user runs:

```bash
remotelab-helper serve
```

6. The helper starts heartbeating and long-polling for commands.
7. The bound RemoteLab session advertises a `local_fs` capability to the model.
8. The model issues `list/find/stat/read_text/stage` calls as needed.
9. `stage` uploads selected files through the normal asset pipeline, after which the file is just a regular RemoteLab attachment.

## Repo shape

### Server-side repo changes

Main code areas:

- `chat/router-control-routes.mjs`
- `chat/router.mjs`
- `chat/session-manager.mjs`
- `chat/file-assets.mjs`
- `chat/history.mjs`

Recommended new modules:

- `chat/local-bridge-store.mjs`
- `chat/local-bridge-routes.mjs`
- `chat/local-bridge-session-tools.mjs`

Suggested responsibilities:

- `chat/local-bridge-store.mjs`
  - persist linked helper devices
  - persist pairing codes
  - persist command queue and command results
  - track helper heartbeats and cursors
- `chat/local-bridge-routes.mjs`
  - owner route to create pairing codes
  - helper routes to pair, heartbeat, pull commands, push results
- `chat/local-bridge-session-tools.mjs`
  - expose the `local_fs` capability into a linked session in a model-friendly way
  - map session-local tool calls to queued bridge commands

`chat/file-assets.mjs` should stay the canonical path for staged file ingestion.

### Helper repo subtree

Add a new top-level Go module:

```text
local-helper/
  go.mod
  cmd/remotelab-helper/main.go
  internal/config/
  internal/client/
  internal/fsbridge/
  internal/stage/
```

Why a top-level module:

- keeps the existing Node.js repo clean
- makes `go build` and cross-compilation explicit
- avoids pretending the helper is part of the current runtime path when it is actually a separate local binary

## Helper process model

V0 subcommands:

- `pair`
- `serve`
- `doctor`

### `pair`

- exchanges a short-lived pairing code for `deviceId` and `deviceToken`
- stores config under the platform config directory

### `serve`

- starts heartbeat loop
- starts long-poll loop for commands
- executes commands serially for V0
- uploads staged files directly to RemoteLab asset endpoints

### `doctor`

- prints config location
- verifies server reachability
- verifies configured roots exist
- prints last heartbeat and last command cursor

## Helper configuration

V0 config should be JSON and intentionally simple.

Example:

```json
{
  "serverUrl": "https://your.remotelab.host",
  "deviceId": "dev_001",
  "deviceToken": "secret_xxx",
  "allowedRoots": {
    "projects": "/Users/alice/Projects",
    "desktop_imports": "/Users/alice/Desktop/imports"
  },
  "limits": {
    "maxReadBytes": 65536,
    "maxStageBytes": 268435456,
    "maxFindResults": 200
  },
  "stage": {
    "allowedExtensions": [
      ".rvt",
      ".dwg",
      ".ifc",
      ".pdf",
      ".txt",
      ".csv",
      ".xlsx",
      ".docx"
    ]
  }
}
```

Config location:

- macOS: `~/Library/Application Support/RemoteLabHelper/config.json`
- Linux: `~/.config/remotelab-helper/config.json`
- Windows: `%AppData%\\RemoteLabHelper\\config.json`

## Command contract

The model should never pass raw absolute filesystem paths.

Instead every request uses:

- `rootAlias`
- `relPath`

This gives us a stable containment boundary and a cleaner model-facing API.

### `list`

Request:

```json
{
  "commandId": "cmd_001",
  "name": "list",
  "args": {
    "rootAlias": "projects",
    "relPath": ".",
    "depth": 1
  }
}
```

### `find`

Request:

```json
{
  "commandId": "cmd_002",
  "name": "find",
  "args": {
    "rootAlias": "projects",
    "relPath": ".",
    "query": "tower",
    "glob": "*.rvt",
    "maxResults": 50
  }
}
```

### `stat`

Request:

```json
{
  "commandId": "cmd_003",
  "name": "stat",
  "args": {
    "rootAlias": "projects",
    "relPath": "A/model/main.rvt"
  }
}
```

### `read_text`

Request:

```json
{
  "commandId": "cmd_004",
  "name": "read_text",
  "args": {
    "rootAlias": "projects",
    "relPath": "A/notes/scope.txt",
    "offset": 0,
    "maxBytes": 65536,
    "encoding": "utf-8"
  }
}
```

### `stage`

Request:

```json
{
  "commandId": "cmd_005",
  "name": "stage",
  "args": {
    "rootAlias": "projects",
    "relPath": "A/model/main.rvt",
    "purpose": "attach_to_session"
  }
}
```

Response:

```json
{
  "commandId": "cmd_005",
  "ok": true,
  "result": {
    "assetId": "asset_123",
    "filename": "main.rvt",
    "size": 182736451,
    "sha256": "..."
  }
}
```

## Session integration

The local helper should be session-bound, not ambiently available everywhere.

Suggested session metadata:

- `localBridgeDeviceId`
- `localBridgeState`

Basic lifecycle:

- session linked to helper
- helper heartbeating
- `local_fs` tool available in that session
- helper missing or stale -> tool hidden or returns a clear unavailable state

Do not make the helper a global machine capability by default in V0.

## Pairing and auth

V0 auth should stay device-scoped, not owner-cookie-scoped.

Suggested records:

- pairing code
- expiry
- session or workspace target
- issued `deviceId`
- issued `deviceToken`

Recommended flow:

1. owner creates pairing code from a session
2. helper redeems pairing code
3. server returns durable device credentials
4. helper uses `Authorization: Bearer <deviceToken>` for all later calls

This is intentionally simpler than full connector/binding UX, but still preserves a real identity boundary.

## Transport and recovery

Routes can look roughly like:

- `POST /api/local-bridge/pair`
- `POST /api/local-bridge/devices/:deviceId/heartbeat`
- `GET /api/local-bridge/devices/:deviceId/commands/next`
- `POST /api/local-bridge/devices/:deviceId/commands/:commandId/result`

Recovery rules:

- helper stores last acknowledged cursor locally
- helper includes cursor on the next long-poll request
- server only returns pending commands
- helper uses exponential backoff on connection failures

V0 should execute one command at a time to keep logs and debugging simple.

## Read-only and staging constraints

Even in trusted internal mode, V0 should keep these hard rules:

- resolve final path and verify it remains inside `allowedRoots`
- reject unknown `rootAlias`
- reject attempts to escape root via `..`
- reject symlink / junction escape if the resolved real path leaves the root
- `read_text` only for text-like content or successful text sniff
- `read_text` always capped by `maxReadBytes`
- `stage` only for allowed extensions and `maxStageBytes`
- no write / rename / delete / execute surface at all

This keeps V0 permissive on workflow, but not ambiguous on filesystem power.

## Why `stage` is mandatory in V0

Path discovery plus text reads alone will not be enough for the real target workflows.

In practice, the model will quickly need to bring binary artifacts into the session:

- `.rvt`
- `.dwg`
- `.ifc`
- `.pdf`

So the smallest useful bridge is not "read local text files."
It is:

- find likely files
- inspect metadata
- read lightweight text when helpful
- stage the real asset into RemoteLab when needed

## Mac-first validation rules

Because internal testing may happen on macOS first:

- the first fully exercised path can be macOS
- default example roots in docs/examples should include macOS paths
- the helper should avoid Windows-only assumptions in core logic
- path normalization and config-dir discovery should be abstracted in the helper from day one

That said:

- do not add launchd integration in V0
- do not add notarization in V0
- do not add Finder UI or menu bar UI in V0

The first Mac operator flow can remain:

1. download binary
2. run `pair`
3. run `serve`

## Windows support strategy

Windows should still remain an explicit target in code structure:

- keep path handling OS-aware
- keep config-dir selection OS-aware
- keep test fixtures for both slash styles
- avoid assuming case-sensitive paths

But V0 should not block on:

- signed installer
- system tray
- startup registration
- UNC share support
- OneDrive placeholder edge cases

## Simplest owner flow

The owner-facing flow should stay small:

1. session action: create helper pairing code
2. local machine: run helper `pair`
3. local machine: run helper `serve`
4. session now has `local_fs`

Do not build a rich helper-management dashboard in V0.

## Minimal implementation plan

### Slice 1 — server-side bridge skeleton

- pairing code creation
- device record persistence
- heartbeat and long-poll routes
- command queue persistence

### Slice 2 — helper skeleton

- Go module
- `pair/serve/doctor`
- config load/save
- heartbeat loop
- command loop

### Slice 3 — filesystem commands

- `list`
- `find`
- `stat`
- `read_text`
- containment checks

### Slice 4 — staged file upload

- reuse existing file-asset upload intent/finalize flow
- return uploaded asset metadata back to the session tool result

### Slice 5 — session integration

- bind helper to a session
- expose `local_fs` only when a live helper exists
- record bridge command calls in session history or run metadata for debugging

### Slice 6 — internal dogfood and pruning

- run on macOS first
- capture which commands are actually used
- check whether `find + stage` dominates `read_text`
- trim the protocol before any external-user packaging pass

## Expected V0 outcome

After this lands, RemoteLab should be able to:

- link one trusted local machine to one active session
- let the model discover local files inside approved roots
- selectively read small text files
- stage binary assets into the normal attachment flow
- do all of that with a helper that is simple enough to run first on macOS and later build for Windows/Linux from the same codebase
