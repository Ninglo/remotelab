# Automation Agents

RemoteLab can treat recurring automations as first-class Agents instead of leaving them as invisible background jobs.

That means an automation is not only:

- a local script,
- a scheduler entry,
- and maybe a push notification,

but also:

- an Agent with a reusable prompt/persona,
- a stable owner-side session for review,
- and a consistent connector path for inbound automated updates.

## Why this pattern exists

Many useful RemoteLab workflows are not ordinary human chat:

- GitHub issue / PR triage
- recurring maintenance reviews
- memory cleanup / compaction checks
- product / competitor scouting
- mailbox or bot-driven automation

But they still fit the same core RemoteLab model:

1. something produces an inbound update,
2. RemoteLab owns the durable session,
3. the AI agent replies in that session,
4. the owner reviews and continues from the same place.

So the automation should show up as a recognizable Agent/session surface, not as a hidden cron side effect.

## Core model

An automation Agent has three layers.

### 1. Agent template

Use a normal RemoteLab Agent to package:

- name
- system prompt
- welcome message
- preferred tool

This gives the automation a clear identity and reusable behavior.

### 2. Connector / scheduler

A local script or external connector does the transport work:

- polls or receives upstream events
- normalizes them into a digest or message
- authenticates to RemoteLab as the owner
- creates or reuses the correct session
- submits the update as a user message

### 3. Review session

The actual review surface is a stable RemoteLab session, usually keyed by `externalTriggerId`.

That session is where the owner:

- reviews the AI's judgment
- asks follow-up questions
- decides what to ship
- preserves context over time

## Recommended workflow

For a new automation Agent:

1. Create the Agent in RemoteLab.
2. Give it a system prompt that matches the automation's role.
3. Pick a stable `externalTriggerId` for the review thread.
4. Make the connector create/reuse that session.
5. Submit each automation digest through `POST /api/sessions/:sessionId/messages`.
6. Let normal session history and push behavior handle review and follow-up.
7. Keep machine-local schedule, secrets, and notifier channels outside the repo.

## Session metadata contract

Automation connectors should usually set:

- `sourceId`
- `sourceName`
- `templateId`
- `templateName`
- `group`
- `description`
- `systemPrompt` (copied from the Agent template when needed)
- `externalTriggerId`

This gives the owner UI a meaningful Agent/source surface and keeps one automation thread mapped to one durable RemoteLab session.

## Relationship to shareable Agents

This pattern reuses the same Agent model, but the purpose is different.

- Shareable visitor Agents are public entry points.
- Automation Agents are owner-side operational templates.

They still benefit from the same primitives:

- reusable prompt packaging
- stable naming
- tool defaults
- session categorization

## Current examples

- `GitHub` automation sessions bridged through the external-message protocol
- scheduled maintenance / review sessions under `automation`
- `Agent Radar` for recurring remote-agent-control scouting

## Implementation guidance

- Put shared connector logic in the repo when it is generally reusable.
- Keep local schedule, credentials, and notification channels machine-local.
- Prefer one stable review session per automation thread over creating noisy one-off sessions.
- Use notifications as pointers into the review session, not as the only review surface.
- When possible, let RemoteLab's own completion/session mechanisms stay the source of truth.

## Related docs

- `external-message-protocol.md`
- `remote-capability-monitor.md`
- `creating-apps.md`
