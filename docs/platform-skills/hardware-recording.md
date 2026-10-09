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
- `free3p` requires learning its actual HID events and verifying a short recording on the first machine. The helper does not seize the keyboard: configure unused function keys so events do not type text or invoke normal application shortcuts.
- On macOS, a keyboard HID device can also send consumer-control events through a separate HID collection. The listener opens the collections for explicitly bound vendor/product pairs and checks each event's full serial/location identity before emitting it; opening only the keyboard collection can miss Bluetooth consumer controls. `learn-input` reports `usagePage: 7` for keyboard keys and `usagePage: 12` for consumer controls. Bind the learned page explicitly when it is 12; existing bindings default to page 7. USB and Bluetooth may expose different device IDs and key codes, so learn and bind each transport separately. A Free3-P Bluetooth sample used consumer page 12 even though USB used page 7; this proves receipt of that input, while wireless recording and distance still require physical acceptance. The device's brief key light confirms local key response; use the recording window to confirm actual capture.
- Optional `session.tool` chooses an installed Harness; otherwise the service selects an available one. A lane may specify `sessionId`, or `conversation` in the canonical [conversation target format](../external-message-protocol.md). Default is a fresh Session for each recording. Conversation and Session targets are mutually exclusive. Use this instance's auth and base URL; cross-instance credential provisioning is outside this capability.
- Capture and delivery are separate choices. Set `submissionMode: "local"` to keep keypad/UI recording available while saving audio only on this machine. This stops all upload/Session requests, including pending retries from earlier recordings. New and recovered recordings retain their local-only choice as `held`; switching the config back to the default `"automatic"` does not replay them. There is no automatic release of held recordings. Keep the setup Session out of the delivery bindings when the user already has a dedicated recording-analysis workflow; discover its actual upload entry and conversation before preparing delivery. A request to prepare that route does not authorize sending test recordings to a real group.

### Original audio and analysis in one Feishu topic

> 固化已获授权的单键录音上传：保持已核实的设备、单路采音和按键绑定，为后续新录音配置已有录音群。启用该 lane 的 `publishAudio: true`，使用本实例已登记的 Feishu conversation 与 sourceRouteId，不复制 Bot 凭据到采集机。先验证带测试标记的一条新录音：原音在群中可下载、分析回到同一话题、重试不重复发群。保留所有原音与历史 held 记录，不补发旧录音；保存最终配置、服务入口、回执及暂停方法。

This is opt-in: `publishAudio: true` requires the lane's explicit Feishu
`conversation` and `target.chatId`. Use a group-only target for a fresh topic
per recording. The collector uploads WAV assets, queues them through the
existing instance Connector outbox, and waits for confirmed file delivery
before admitting analysis. The first file receipt supplies the Session's
topic anchor; remaining segments and the final analysis use that topic.
Bot self-message filtering remains intact: an uploaded Bot file does not
pretend to be a human inbound event. Analysis enters through the recording
API using a stable request ID.

The saved manifest retains the original publication request, asset IDs,
delivery ID and confirmed topic, so lost HTTP replies reuse them. Unknown
provider delivery stays unresolved and must be inspected rather than sent
again with a new identity. Old local/held recordings are not released.
WAV filenames include the lane label; use a clearly marked test label for
acceptance and restore the ordinary label afterward. Optional
`session.systemPrompt` supplies the authorized recording-analysis workflow;
test instructions should exclude project/day-report/task changes.

On an analysis instance already configured for Doubao voice input,
`scripts/recording-transcribe-doubao.mjs --file ORIGINAL.wav --output-dir SOURCE_DIR`
is the reusable server-side transcription entry. It reads existing instance
credentials, accepts the recorder's mono 16 kHz PCM16 WAV, and saves
`transcript.raw.txt` plus `remote-response.json` without changing the original.
Use it from the recording-analysis workflow on the analysis server; do not
install a local model or copy those credentials to the capture Mac. Its help
does not require configured credentials. Keep every segment's raw response.
Finished WAVs use Doubao's `bigmodel_nostream` endpoint, with the same existing
credentials ([official API](https://docs.volcengine.com/docs/6561/2628951?lang=zh)).
The helper accepts completion only after a final response whose audio duration
covers the whole input. The receipt retains the original SHA-256, sent PCM byte
count, final-response flag and recognized duration. A timeout or early close
keeps partial text with `state: failed` / `transcriptState: partial`; do not
present that text as a complete transcript. A successful empty result has
`hasSpeech: false` and needs an audio check, rather than a claim that speech
was recognized. Original WAVs stay unchanged and can be retried directly,
without re-uploading or opening another Session. For a long discussion, process
every ordered five-minute segment and retain its receipt before combining text.

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
| `held` | Audio saved locally; no upload or analysis request authorized for this recording |
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

## Optional Free3 single-key recording light

> Prepare the optional Free3 USB recording indicator on this recording host. Verify the actual keypad serial, lane and physical key first. Inspect `scripts/recording-free3-light.mjs --help` and the installed vendor editor's light protocol. Keep the existing recorder and its permission-bearing app unchanged. Probe the exact USB device before enabling any light writes. When authorized, verify red light only after the recorder saves PCM, light off after stop or capture failure, and the saved audio separately. Do not enable uploads or other keys as part of this setup.

The standalone helper needs explicit `--root`, `--lane`, `--key`, `--serial` and `--serial-module` paths. It uses the installed vendor `serialport` package rather than adding a mandatory RemoteLab dependency; on macOS, run it with the vendor Electron executable and `ELECTRON_RUN_AS_NODE=1`. `--probe` reads model/firmware without changing lights. Selection requires USB VID/PID `4c4a:4155` and the supplied serial; an unrelated serial device is never used. The helper refuses a different model or an occupied serial port.

The inspected HanLinYue editor 1.3.3 sends `{o:"set",k:1,m:"light",v:{enable:true,rgb:"255,0,0",bri:70}}` over its 460800-baud USB serial interface. Its newer Web editor also adds `s: "P"`, `"M"` or `"R"` for Free3's selected settings bank. Inspect the actual physical switch and use the matching optional `--shift` for both on and off; do not change key mappings or other banks to test lighting. Long JSON commands use its 64-byte segmented framing. This establishes a software control path; firmware acceptance and visible steady light still require the actual keypad. USB write success is reported separately from physical confirmation. Bluetooth-only light control, setting durability and firmware behavior on cable loss remain unverified.

The helper reads the existing recorder's local control socket, watches recording state changes, and checks service health once per second. `starting`, stopped, unreadable state and an unresponsive recorder select light off; only the selected lane's live `recording` state selects red. It serializes light writes and clears the selected light on normal exit. A broken USB link cannot receive a clear command: keep the data cable connected, observe disconnect behavior during acceptance, and use the recording window as the authoritative fallback until that behavior is verified. The helper never starts/stops audio, changes keypad bindings or uploads files. It is opt-in and is not installed as a login service automatically.

## Acceptance boundary

Automated tests use synthetic audio, two receiver streams, real local asset uploads, RemoteLab message admission and a fake Harness. They cover independent start/stop, receiver failure isolation, segment repair, disk bounds, interrupted data, retry identity and instance-local daemon control. CI compiles the macOS helper without accessing devices. These are software evidence.

When physical checks are authorized, use actual receivers/keypads to record distinct short samples on all lanes; stagger starts/stops, disconnect one receiver, reconnect it, and confirm all raw files, destination bindings, transcripts and final deliveries. Also confirm normal office audio/typing and screen sleep behavior. Hardware permission grants, stable identity on reconnect, free3p event compatibility, USB stereo output and real transcription remain host-level acceptance items. Add receivers within measured USB/CPU/disk capacity; the implementation imposes no global two-channel ceiling and makes no unmeasured promise about maximum concurrent receivers.

Reference: [FFmpeg AVFoundation](https://ffmpeg.org/ffmpeg-devices.html#avfoundation), [DJI Mic Mini 2 manual](https://dl.djicdn.com/downloads/MIC_MINI_2/20260421/UM/MINI2_um_en2.pdf).
