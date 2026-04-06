# Remote Capability Monitor

The remote capability monitor is a recurring RemoteLab automation Agent that scouts the remote-control coding-agent space and feeds the result back into a reviewable RemoteLab session.

It is meant to answer a focused question continuously:

- what are direct competitors and adjacent tools shipping for remote control of local coding agents,
- what changed recently,
- and which of those changes are worth adapting inside RemoteLab.

## Primary tracked surfaces

The monitor is designed to follow exact, machine-readable sources where possible.

Current examples:

- `slopus/happy`
- `slopus/happy-cli`
- `anthropics/claude-code`
- `Claude Code Remote Control` news coverage
- `openai/codex`

The `Happy` project matters here because it is an explicit remote-control product surface:

- `slopus/happy` — mobile and web client for Claude Code and Codex
- `slopus/happy-cli` — local CLI bridge / wrapper for remote control of local coding tools

## How it fits RemoteLab

This monitor should not stop at local logs or standalone notifications.

The intended flow is:

1. fetch and score source updates
2. write a local report and JSON summary
3. create or reuse a stable RemoteLab review session under an automation Agent
4. submit the digest into that session
5. let the AI produce the review/proposal inside RemoteLab
6. optionally notify the owner with a deep link into that session

That makes the real review surface a normal RemoteLab session instead of an external dashboard.

## Agent pattern

A good monitor rollout uses a dedicated Agent, for example `Agent Radar`, with:

- a system prompt focused on competitive/product judgment
- a stable session identity via `externalTriggerId`
- one recurring review thread for the automation

This keeps the automation:

- reviewable
- resumable
- easy to follow up on
- grouped cleanly in the owner UI

## Shared vs local split

Shared logic lives in the repo:

- `scripts/remote-capability-monitor.mjs`

Machine-local setup stays outside the repo:

- source tuning
- notifier channels
- scheduler setup
- auth/token files
- concrete Agent/session IDs for that machine

## Local config shape

Typical local config includes:

```json
{
  "bootstrapHours": 72,
  "reportDir": "~/.remotelab/research/remote-capability-monitor",
  "notification": {
    "notifierPath": "~/.remotelab/scripts/send-multi-channel-reminder.mjs",
    "channels": []
  },
  "remotelab": {
    "baseUrl": "http://127.0.0.1:7690",
    "authFile": "~/.config/remotelab/auth.json",
    "sessionFolder": "~/code/remotelab",
    "session": {
      "agentId": "app_...",
      "externalTriggerId": "automation:agent-radar:remote-capability-scout"
    }
  },
  "sources": []
}
```

## Source types

Supported source types:

- `google_news_rss`
- `rss`
- `atom`

Per-source tuning can include:

- `lookbackHours`
- `maxItems`
- `baseWeight`
- `target`
- `mustMatchAny`
- `mustMatchAll`
- `lowConfidence`

## Outputs

Typical outputs are:

- state in `~/.config/remotelab/remote-capability-monitor/`
- reports in `~/.remotelab/research/remote-capability-monitor/`
- a stable RemoteLab review session for the automation
- optional deep-link notifications

## Operational rule

When the monitor is connected to a RemoteLab review session, that session should be treated as the primary review surface.

Notifications are helpful, but they should point back to the session rather than replace it.
