# Voice Gateway Direct POC

This note captures the narrow question behind the current experiment:

- Can RemoteLab avoid relaying browser microphone audio through the host machine?
- If yes, can the browser talk directly to Volcengine's AI Gateway Realtime endpoint for Doubao-ASR?

## Current RemoteLab Path

The current voice input path is intentionally server-relayed:

- browser opens `/ws/voice-input/doubao`
- RemoteLab authenticates that websocket locally
- server relay opens `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async`
- relay injects `X-Api-App-Key`, `X-Api-Access-Key`, `X-Api-Resource-Id`, `X-Api-Connect-Id`

Relevant code:

- `static/chat/voice-input.js`
- `chat/ws.mjs`
- `chat/voice-doubao-relay.mjs`

Because browser `WebSocket()` cannot attach arbitrary custom request headers, the current `openspeech` endpoint is not a realistic browser-direct target.

## New Experiment Assets

- Browser POC page: `/voice-gateway-direct-poc.html`
- Browser POC logic: `/voice-gateway-direct-poc.js`
- Node probe: `scripts/voice-gateway-direct-probe.mjs`

## What The New POC Assumes

Volcengine's Realtime docs for AI Gateway say:

- Doubao-ASR Realtime uses `wss://ai-gateway.vei.volces.com/v1/realtime?model=bigmodel`
- auth is `Authorization: Bearer $YOUR_API_KEY`
- for browser JavaScript websocket requests, the voice-agent docs say to use `Sec-WebSocket-Protocol` subprotocol auth following the OpenAI-style browser pattern

The browser POC therefore uses the inferred subprotocol sequence:

```text
realtime
openai-insecure-api-key.<API_KEY>
openai-beta.realtime-v1
```

This is an inference, not a confirmed Doubao-ASR-specific statement from the ASR page itself.

## What The Node Probe Can Prove

Without a real gateway API key:

- the gateway endpoint is reachable
- the gateway returns a consistent auth-layer error surface

With a real gateway API key:

- header auth can be verified directly from Node
- inferred browser-style subprotocol auth can be tested against the same ASR Realtime target
- if the subprotocol path opens and returns `transcription_session.updated`, browser-direct is effectively validated

## Remaining Hard Boundary

If a deployment requires optional `X-Api-Resource-Id` at connection time, the browser POC cannot send it because there is no documented browser-side workaround for that header. In that case the viable paths are:

- bind the required access into the gateway API key so the extra header is unnecessary, or
- keep a relay/proxy close to the user instead of routing audio through the main RemoteLab host.
