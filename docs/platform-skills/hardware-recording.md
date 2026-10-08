# Hardware discussions → RemoteLab

Give this to the AI running on the machine that owns the receiver and keypad:

> Enable RemoteLab hardware recording on this machine using `remotelab recording`. Read this guide and check the instance's software first. Collect the lane-to-keypad and delivery bindings once. Use the explicitly selected receivers; preserve the computer's normal audio settings and foreground applications. Start device discovery and a short acceptance recording only when authorized. Configure an optional user service, read back its status, and report software readiness, physical acceptance, and remote transcription readiness separately. Keep original audio and pending submissions recoverable.

The result is a reusable, optional capability shipped with RemoteLab on macOS and Linux. A keypad starts or ends one discussion. The machine saves that receiver channel locally; RemoteLab receives the finished audio in a Session for the configured Harness to transcribe and analyze. The capture service runs no transcription model. This does not enable hardware automatically after an upgrade.

## Collect once

Ask for the following together, using context already provided:

- Which physical receivers and keypad(s) belong to this instance? Multiple DJI Mic Mini 2 receivers are supported by the design. Each receiver must output **S (stereo)** mode with two independent transmitter channels.
- Which receiver/transmitter belongs to each independent discussion lane? Which keypad/button starts and stops each lane? Use separate start/stop buttons or a toggle. A shared keypad can have different buttons for different lanes.
- Where should each lane's result go: a fresh Web Session per recording, an existing Session, or a new Session bound to an existing Connector conversation? An existing Session retains its conversation. Obtain an authorized conversation target from the normal Connector workflow; do not infer a group from completion order.
- Which existing remote transcription capability can the instance's Harness use? Capture and Session submission work independently of this. If none is configured, report that prerequisite instead of silently installing a heavy local model.
- Are hardware discovery and a short test recording authorized? If the user asks to defer physical verification, prepare the software and configuration without reading keypad or audio devices.

[HUMAN] On macOS, grant Microphone access to the process used by FFmpeg and Input Monitoring to the installed keypad helper when macOS requires it. Programming an unused keypad function key and physically confirming transmitter/channel assignment may also require a person. The AI handles executable installation, config, service setup and readback where its runtime permits.

## Instance-local configuration

`remotelab recording --help` is the command contract. `doctor` checks software and config only; it does not open audio or keypad devices. `devices` performs explicit discovery. `learn-input --device ID` reports the selected keypad's numeric key-down codes for binding, without using a global keyboard hook. These actions are opt-in and do not run during ordinary RemoteLab startup.

State defaults to `<REMOTELAB_CONFIG_DIR>/recording` (otherwise the normal RemoteLab config directory). Use the same `--root` throughout if overridden. The machine ID is generated once and preserved when configuring through the CLI. Never copy a live machine's recording state/config wholesale into another instance.

The component requires Node.js 18.15 or newer (for disk-space checks) and FFmpeg. A two-receiver/four-discussion configuration has this shape; substitute discovered identities and learned key codes. This example deliberately uses placeholders and cannot be installed verbatim:

```json
{
  "enabled": false,
  "receivers": [
    { "id": "rx1", "backend": "avfoundation", "source": "uid:RECEIVER_1_UID" },
    { "id": "rx2", "backend": "avfoundation", "source": "uid:RECEIVER_2_UID" }
  ],
  "lanes": [
    { "id": "a", "label": "讨论 A", "receiverId": "rx1", "channel": 0 },
    { "id": "b", "label": "讨论 B", "receiverId": "rx1", "channel": 1 },
    { "id": "c", "label": "讨论 C", "receiverId": "rx2", "channel": 0 },
    { "id": "d", "label": "讨论 D", "receiverId": "rx2", "channel": 1 }
  ],
  "bindings": [
    { "deviceId": "KEYPAD_DEVICE_ID", "key": 104, "laneId": "a", "action": "toggle" },
    { "deviceId": "KEYPAD_DEVICE_ID", "key": 105, "laneId": "b", "action": "toggle" },
    { "deviceId": "KEYPAD_DEVICE_ID", "key": 106, "laneId": "c", "action": "toggle" },
    { "deviceId": "KEYPAD_DEVICE_ID", "key": 107, "laneId": "d", "action": "toggle" }
  ],
  "session": { "folder": "~" },
  "limits": {
    "segmentSeconds": 300,
    "maxSpoolBytes": 5368709120,
    "minFreeBytes": 536870912,
    "maxRecordingSeconds": 21600,
    "uploadBytesPerSecond": 262144
  }
}
```

- Channel `0` means this receiver's left channel; `1` means its right channel. Sources are `(receiverId, channel)`, not global left/right. One capture process opens each active receiver; lane lifetimes are independent. Configuration rejects duplicate sources and ambiguous keypad buttons.
- macOS uses an FFmpeg build exposing AVFoundation `audio_device_id` and `uid:`/`serial:` identities. Older FFmpeg builds without that option fail `doctor`; upgrade them rather than binding same-name receivers by changing numeric indexes. Xcode Command Line Tools compile the included Swift HID helper once per source version.
- Linux uses a stable named ALSA card (`hw:CARD=...`) or a named PulseAudio source, Python 3 and explicit `/dev/input/by-id/...-event-kbd` access. Identical receivers may require distinct stable card names/udev configuration. Grant only the device access needed by the host user. Numeric card indexes and the default source must not be used.
- `free3p` is supported **if it presents the expected keyboard HID events**. Its actual protocol and codes must be learned on the first machine; this implementation has not verified that physical model. The helper does not seize the keyboard: configure unused function keys so events do not type text or invoke normal application shortcuts.
- Optional `session.tool` chooses an installed Harness; otherwise the service selects an available one. A lane may specify `sessionId`, or `conversation` in the canonical [conversation target format](../external-message-protocol.md). Default is a fresh Session for each recording. Conversation and Session targets are mutually exclusive. Use this instance's auth and base URL; cross-instance credential provisioning is outside this capability.

After preparing a config file, the AI uses `configure --file PATH`, `enable`, and `install --apply`, then reads `status`. `install` without `--apply` previews the launchd/systemd user service. On Linux, a usable user systemd manager is required; for service-less environments use `serve` under an existing process supervisor. macOS uses a user LaunchAgent, so logout stops capture. `uninstall --apply` stops/removes the service and preserves the recordings. Stop a manually supervised `serve` process with SIGTERM before changing bindings or disabling the config.

## What the service preserves

Files are private WAV segments under `records/<recording-id>/`, with an atomically saved manifest. Stereo frames stay separated even across partial pipe reads. Files contain mono PCM16 at 16 kHz. Segments remain in one ordered recording and are uploaded after that lane ends. Start/stop operations for one channel do not stop another active channel on the same receiver.

The service directly selects each receiver, does not change the system default microphone/speakers, and does not activate windows. macOS `caffeinate -i` is active only while recording, allowing screen sleep while preventing automatic system sleep. Manual sleep, restart and logout can still interrupt capture. The recording service recovers partial WAV headers at its next start and labels saved interrupted audio accordingly. A lost receiver closes its own lanes; others continue. Reconnection permits a later new recording; it does not fill the missing audio or silently resume an ended discussion. Linux keypad reconnection currently requires restarting the listener/service; macOS HID discovery follows device additions.

Disk usage, free space, duration and upload bandwidth are bounded. The service refuses additional data when the cache is full; it never deletes original audio automatically. Keep local originals until a deliberate archive/removal policy is agreed. A pending submission persists across outages/restarts; six failed attempts become `blocked`, with a reason and explicit `retry --recording ID`. Session IDs, finalized assets and a stable request ID are saved before subsequent steps, preventing duplicate AI turns after a lost response. Remote storage uploads never receive the instance auth cookie.

States mean different things:

| State | Meaning |
| --- | --- |
| active `starting` | Receiver process started; input has not yet delivered verified stereo frames |
| active `recording` | PCM is being saved for that lane |
| `pending` | Audio saved; upload/submission pending |
| `blocked` | Saved audio retained; upload/submission needs retry or configuration repair |
| `submitted` / `analysisState: accepted` | RemoteLab accepted the analysis request; follow the Session/Run for the result |
| `failed` | No usable audio saved; inspect the reason |

`submitted` does not mean transcription or delivery is complete. The normal Session and Connector lifecycle owns those results. `status` exposes active lanes, saved records, Session/Run IDs and keypad errors; it never prints signed upload intents. Software status alone cannot prove transmitter/channel separation: some receiver modes may expose two duplicated channels. The physical acceptance test must confirm them using distinct spoken samples.

## Optional macOS recording window

When an operator needs immediate, persistent feedback, give their AI this prompt:

> Add the native RemoteLab Recording window to this Mac using the shipped Swift host. Use this machine's recording configuration, Node executable and CLI. If a recording app already has macOS permission, keep its executable and signature intact and install a separate panel connected to it; replacing an ad-hoc signed executable can invalidate its grants. Show the window without starting an audio recording; let the operator click its start/stop buttons or use the already bound keypad. Verify actual audio start and saved stop events, then the original file and remote submission separately. Do not use a delayed chat message as the start cue.

`scripts/recording-panel-state.swift` and `scripts/recording-host-macos.swift` compile together with `swiftc` into the optional AppKit host. Package it inside a normal `.app` with `CFBundleExecutable` and a stable `CFBundleIdentifier`; the AI must use the actual local installation paths. For an existing authorized recording app, use `panel --host-app APP_PATH --cli PATH --node PATH --root PATH`. The panel launches that unchanged app only if the configured recorder is not running, verifies its live control socket, watches the daemon's exit event and shows each lane's real state. Mouse commands use the local control socket and require no microphone grant for the panel. Setting `RemoteLabRecordingHostApp`, `RemoteLabCLIPath` and `RemoteLabNodePath` in Info.plist supports normal Finder launch.

On a new installation, `serve --cli PATH --node PATH --root PATH` makes this host own the daemon directly; that app also needs `NSMicrophoneUsageDescription` and its own permission grants. Both modes show a compact row for each lane, with its state, elapsed recording time and an explicit start/stop button. Reopening the installed panel activates the existing window. Do not run a second recorder for the same root. Closing the window gracefully stops a daemon launched by this window and preserves active recordings; attaching to an already running service leaves that service running when the window closes. No login/background installation is implied.

Returning to the panel verifies the control socket again; a failed operation disables controls until service readiness is verified. Signal-driven window exit enters AppKit through its run loop so process-exit callbacks can complete `terminateLater`. Recorder shutdown closes idle control clients after saving active audio, preventing a lingering client from leaving the stopped daemon alive. Verify both window and daemon exit when testing orderly shutdown, not only disappearance of the capture process.

The window watches atomic status changes locally; it has no model call or network dependency. Orange “正在启动” is shown before verified audio arrives, and red “正在录音” only after PCM is being saved. Stopping, local preservation and remote admission remain distinct. A dead child, unreadable status or status from a different daemon cannot leave a red indicator. A keypad fault is shown separately while mouse controls remain available. Red proves active capture, not intelligible speech or correct transmitter assignment. The window is initially kept above other windows; the operator can turn that off. It does not change system volume or play automatic prompts.

`check` reports this app's permission state without opening devices; `permissions` explicitly requests macOS permission. `preview --root FIXTURE_DIR --snapshot PNG_PATH` renders test configuration/status files without starting a daemon, opening hardware or enabling buttons. Keep previews clearly labeled and separate from live recording state. CI compiles the host and tests the state projection without hardware access. Actual window visibility, permission retention, keypad behavior and audible microphone samples still need host-level verification.

## Acceptance boundary

Automated tests use synthetic audio, two receiver streams, real local asset uploads, RemoteLab message admission and a fake Harness. They cover independent start/stop, receiver failure isolation, segment repair, disk bounds, interrupted data, retry identity and instance-local daemon control. CI compiles the macOS helper without accessing devices. These are software evidence.

When physical checks are authorized, use actual receivers/keypads to record distinct short samples on all lanes; stagger starts/stops, disconnect one receiver, reconnect it, and confirm all raw files, destination bindings, transcripts and final deliveries. Also confirm normal office audio/typing and screen sleep behavior. Hardware permission grants, stable identity on reconnect, free3p event compatibility, USB stereo output and real transcription remain host-level acceptance items. Add receivers within measured USB/CPU/disk capacity; the implementation imposes no global two-channel ceiling and makes no unmeasured promise about maximum concurrent receivers.

Reference: [FFmpeg AVFoundation](https://ffmpeg.org/ffmpeg-devices.html#avfoundation), [DJI Mic Mini 2 manual](https://dl.djicdn.com/downloads/MIC_MINI_2/20260421/UM/MINI2_um_en2.pdf).
