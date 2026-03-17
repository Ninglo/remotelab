# Voice Hardware Connector (Prompt-First)

This document is the rollout contract for wiring a wake-word voice connector to RemoteLab.

The design goal is simple:

- microphone + wake-word detection live outside the core server
- the connector turns one spoken request into one normal RemoteLab message
- RemoteLab runs the selected local agent as usual
- the connector converts the final assistant reply back into speaker audio

That keeps voice as just another thin connector on top of the existing session/run/event architecture.

## Copyable Prompt

Use this when handing the setup to an AI coding agent on the RemoteLab machine:

```text
I want you to wire a wake-word voice connector for RemoteLab on this machine.

Target behavior:
- a local microphone listens for a wake phrase
- transcribe wake audio locally
- send it into RemoteLab as one user message
- wait for the assistant reply
- speak the reply back through the local speaker

Machine / hardware:
- OS: macOS or Linux
- microphone device: <device name>
- speaker device: <device name>
- room / connector name: <living-room / desk / kitchen / etc>
- wake phrase: <phrase>

Pipeline choices:
- wake-word layer: <openWakeWord / Porcupine / custom / already have one>
- audio capture layer: <ffmpeg / sox / custom>
- STT layer: <mlx_whisper / whisper.cpp / faster-whisper / cloud API / custom>
- TTS layer: <macOS say / espeak / Piper / cloud API / custom>

RemoteLab session choices:
- tool: <codex / claude / other>
- model: <optional>
- effort: <optional>
- thinking: <true/false>

Constraints:
- keep RemoteLab as the shared runtime and conversation engine
- keep platform-specific audio handling inside the connector
- prefer a stable per-device voice session using externalTriggerId
- keep replies short and speech-friendly

Please:
1. install or verify the needed local dependencies
2. create ~/.config/remotelab/voice-connector/config.json
3. wire the wake/capture/stt/tts commands into scripts/voice-connector.mjs
4. validate with a dry run using --text or --stdin
5. start the persistent connector process
6. report the final command, config path, and validation result
```

## Target State

When the setup is complete, the machine should have:

- one local `voice-connector` process
- one wake pipeline that emits activations
- one local audio/transcribe pipeline, either direct wake-to-transcript or wake + capture + STT
- one durable RemoteLab session per connector/device
- one TTS path back to the speaker

The expected session scope is:

- `appId`: `voice`
- `appName`: `Voice`
- `group`: `Voice`
- `externalTriggerId`: stable per connector, such as `voice:living-room-speaker`

For demos that want one fresh session per wake event instead of one stable device thread, set:

- `sessionMode`: `per-wake`

## Human Checkpoints

Only interrupt the human for items the AI cannot complete alone.

- `[HUMAN]` Grant microphone permission to the terminal / Node process if the OS prompts.
- `[HUMAN]` Confirm the physical microphone and speaker are the intended devices.
- `[HUMAN]` If the wake-word or STT/TTS vendor requires account credentials, provide them once.

Everything else should stay inside the AI session.

## Connector Contract

The shipped implementation lives in `scripts/voice-connector.mjs`.

It supports three operating modes:

- `--text` for one direct transcript smoke test
- `--stdin` for line-by-line development testing
- `wake.command` for the real persistent wake-word loop

### Wake command

`wake.command` should be a long-running process that writes one line per activation to stdout.

Each line may be either:

- plain text — treated as a ready transcript
- JSON — treated as a wake event payload

Supported JSON fields:

- `eventId`
- `wakeWord`
- `transcript`
- `audioPath`
- `detectedAt`
- `connectorId`
- `roomName`
- `metadata`

If the wake layer already provides `transcript`, the connector can skip capture/STT.
If it provides only a wake event, the connector can call `capture.command` and `stt.command` next.

### Capture command

`capture.command` is optional.

It receives `REMOTELAB_VOICE_*` environment variables and may output either:

- a plain audio file path
- JSON with `{ "audioPath": "..." }`
- JSON with `{ "audioPath": "...", "transcript": "..." }`

### STT command

`stt.command` receives `REMOTELAB_VOICE_AUDIO_PATH` and should output either:

- plain transcript text
- JSON with `text` or `transcript`

### TTS command

The connector supports:

- macOS `say` directly via `tts.mode: "say"`
- a custom `tts.command`

For a custom command, the reply is passed both as stdin and as `REMOTELAB_VOICE_REPLY_TEXT`.

## Example Config

```json
{
  "connectorId": "desk-speaker",
  "roomName": "Desk",
  "chatBaseUrl": "http://127.0.0.1:7690",
  "sessionFolder": "~",
  "sessionTool": "codex",
  "sessionMode": "per-wake",
  "thinking": false,
  "systemPrompt": "You are validating a local wake-word connector. Reply in the user's language with one short sentence that repeats the recognized transcript. Do not take external actions.",
  "wake": {
    "mode": "command",
    "command": "~/.tmp/asr-venv/bin/python /Users/jiujianian/code/remotelab/scripts/voice-wake-loop.py --phrase \"Hello World\" --transcript-mode full --model mlx-community/whisper-large-v3-turbo-q4 --language en --chunk-seconds 1.8 --cooldown-ms 2500 --ack-sound-path \"/System/Library/Sounds/Glass.aiff\"",
    "keyword": "Hello World"
  },
  "tts": {
    "enabled": false
  }
}
```

This one-stage setup is the simplest validation path:

- `ffmpeg` reads the microphone
- `mlx_whisper` transcribes each short chunk locally
- the wake loop emits a JSON event that already includes `transcript`
- `scripts/voice-connector.mjs` sends that transcript straight into a new RemoteLab session

`capture.command` and `stt.command` stay available for more advanced flows, but they are not required for the first hello-world demo.

## Built-in helper scripts

This repo now ships a generic Python wake path that keeps the core logic outside the main server and outside platform-specific app code:

- `scripts/voice-utterance-loop.py` — passive always-on utterance listener; any detected full utterance becomes one RemoteLab message
- `scripts/voice-wake-loop.py` — always-on wake listener using short microphone chunks plus local `mlx_whisper`
- `scripts/voice-capture-until-silence.py` — one-shot follow-up capture that waits for speech and stops after trailing silence
- `scripts/voice-record-once.py` — one-shot microphone capture helper using `sounddevice` when available, with `ffmpeg` fallback
- `scripts/voice-transcribe-mlx.py` — one-shot local transcription helper using `mlx_whisper`
- `scripts/voice-connector-instance.sh` — start/stop/status helper for the persistent connector process

On macOS, microphone permissions are app-context-sensitive. A fully headless `nohup` process launched from a non-authorized host can look "alive" while actually recording zeros. The default instance helper therefore uses `Terminal.app` only as a short permission bootstrap on startup, then detaches the real connector into the background and closes the Terminal window.

## Passive Speech Mode

For the simplest demo, you do not need a wake phrase at all.

In passive speech mode:

- the connector continuously listens for any utterance
- once speech starts, it keeps recording until trailing silence
- the whole utterance is transcribed locally
- that transcript is sent into a fresh RemoteLab session turn

This mode is intentionally simple and good for evaluation, but it will also react to background human speech or other nearby voice audio. It is a demo path, not yet a production-grade wake-word filter.

## Wake-Gated Utterance Mode

For a much lower false-trigger rate without reintroducing a two-stage pause workflow, `scripts/voice-utterance-loop.py` also supports a single-utterance wake phrase gate.

In this mode:

- the connector still captures one full utterance until trailing silence
- the full utterance is transcribed locally first
- only utterances that start with the configured wake phrase are accepted
- the wake phrase can match fuzzily within a small edit distance
- only the trailing content after the wake phrase is sent into RemoteLab

Example:

- spoken: `小罗小罗，帮我看一下今天下午的安排`
- submitted transcript: `帮我看一下今天下午的安排`

This is the recommended default when passive mode is too noisy but a separate wake-beep-then-follow-up flow feels awkward.

## Optional macOS prototype helpers

The older Swift-based prototype remains in the repo as an optional macOS-only branch for experiments, but it is no longer the recommended core path:

- `scripts/voice-wake-phrase.swift` — always-on wake listener using macOS Speech; can optionally play a short acknowledgement sound before it emits the wake event
- `scripts/voice-capture-until-silence.swift` — captures one follow-up utterance and stops after about 1 second of silence
- `scripts/music-open.mjs` — a separate local-action demo, not part of the core voice ingress path

Example machine-local config for that macOS-only prototype shape:

```json
{
  "connectorId": "desk-speaker",
  "roomName": "Desk",
  "chatBaseUrl": "http://127.0.0.1:7690",
  "sessionFolder": "~",
  "sessionTool": "codex",
  "sessionMode": "per-wake",
  "thinking": false,
  "systemPrompt": "You are Rowan speaking through a local wake-word voice connector on the owner's Mac. You may use shell commands, osascript, and local scripts on this machine when useful. For music playback requests, prefer running `node /Users/jiujianian/code/remotelab/scripts/music-open.mjs --preset apple-music-classical` for generic classical music, or `node /Users/jiujianian/code/remotelab/scripts/music-open.mjs --query \"<query>\"` for a search. When a local action is possible, do it before replying. Reply with exactly the short text that should be spoken aloud.",
  "wake": {
    "mode": "command",
    "command": "swift /Users/jiujianian/code/remotelab/scripts/voice-wake-phrase.swift --phrase \"Hello World\" --locale en-US --cooldown-ms 3000 --restart-delay-ms 1200 --on-device true --allow-server-fallback true --ack-sound-path \"/System/Library/Sounds/Glass.aiff\"",
    "keyword": "Hello World"
  },
  "capture": {
    "command": "swift /Users/jiujianian/code/remotelab/scripts/voice-capture-until-silence.swift --timeout-ms 20000 --speech-start-timeout-ms 8000 --silence-ms 1000 --locale zh-CN --on-device true --allow-server-fallback true",
    "timeoutMs": 30000
  },
  "tts": {
    "mode": "say",
    "voice": "Tingting",
    "rate": 185,
    "timeoutMs": 120000
  }
}
```

Start the persistent demo instance with:

```bash
./scripts/voice-connector-instance.sh start
```

On macOS, the instance helper may launch the connector through `Terminal.app` when you explicitly choose that mode, but the generic `ffmpeg + mlx_whisper` path does not require Swift as the core runtime.

For a direct wake-layer smoke test without speaking, run:

```bash
swift /Users/jiujianian/code/remotelab/scripts/voice-wake-phrase.swift --phrase "Hello World" --ack-sound-path "/System/Library/Sounds/Glass.aiff" --test-trigger
```

## Validation

Start with the cheapest checks first:

```bash
npm run voice:connect -- --config ~/.config/remotelab/voice-connector/config.json --text "Hello there" --no-speak
```

Then a local interactive pass:

```bash
npm run voice:connect -- --config ~/.config/remotelab/voice-connector/config.json --stdin
```

Then a wake-layer smoke test using a prerecorded file:

```bash
~/.tmp/asr-venv/bin/python /Users/jiujianian/code/remotelab/scripts/voice-wake-loop.py --phrase "Hello World" --transcript-mode full --model mlx-community/whisper-large-v3-turbo-q4 --language en --test-file /tmp/hello-world.wav
```

Then the real wake loop:

```bash
npm run voice:connect -- --config ~/.config/remotelab/voice-connector/config.json
```

Expected outcome:

- a `Voice` session is created or reused in RemoteLab
- the spoken text appears as a normal user message in that session
- the assistant reply is short and speech-friendly
- if TTS is enabled, the reply is spoken through the configured TTS path

## Architecture Fit

This connector does not require a new core runtime model.

It follows the same contract as Feishu, GitHub, and other external connectors:

1. authenticate to RemoteLab
2. create or reuse a session
3. submit one normalized message
4. wait for the run to complete
5. fetch the assistant reply from session events
6. render that reply back into the upstream surface

The only new surface area is the local audio pipeline around the connector.
