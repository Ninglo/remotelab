# Creating Agents

This doc describes the current product direction and the current code mapping.

User-facing language is **Agent**.
Internal storage still reuses the older **app/template** layer in several places, but the owner CRUD and public share surface are now expressed as **Agent**.

## Core model

RemoteLab should be read as:

- **Source / Channel** — where a session came from
- **Agent** — the reusable behavior/context that shapes the session
- **Session** — the concrete work thread
- **Run** — one execution attempt inside the session

Relationship:

```text
Source -> Session <- Agent
             |
             -> Run
```

Examples:

- `Email`, `Feishu`, `RemoteLab web`, `API`, `automation` are **Sources**
- `Chat`, `Drawing`, `Report Cleanup`, `Invoice Follow-up` are **Agents**

Do not treat a source surface as an agent just because it has a dedicated page.
For example, a drawing request started from Feishu and a drawing request started from the RemoteLab web UI are still the same kind of **Session** if they run under the same drawing **Agent**.

## What an Agent is

An Agent is the reusable definition that answers:

- what this capability is for
- what stable instructions should always apply
- what reusable context should be available
- which tool/runtime it should prefer
- what kind of output it should produce

In current code, that reusable layer maps to the internal **app/template** persistence model.

Practically, an Agent today is carried by:

- `templateId` / `templateName` on the session
- `systemPrompt` on the session
- optional saved `template_context` events
- default tool/runtime from the saved app/template record

The key rule is:

- **Source** tells us how the session started
- **Agent** tells us how the session should behave

Applying an Agent must not silently redefine the session source.

## Current v1 product flow

Short-term, the product stays intentionally simple:

- `Sessions` remains the main work surface
- `Agent` is a top-level management panel
- `Settings` stays limited to base configuration
- source/channel routing stays mostly implicit

Current expected behavior:

1. The owner creates an Agent through chat, not through a heavy form.
2. The Agent appears in the top-level **Agent** panel.
3. A new web session can be started under a chosen Agent.
4. Other sources can continue to default to the normal `Chat` agent until explicit routing is added later.

This keeps first use lightweight while preserving a clean model for later source/channel expansion.

## Current code mapping

For the current codebase, use this translation table:

| Product concept | Current storage / API shape |
|---|---|
| Agent | app/template record |
| Session source | `sourceId` / `sourceName` |
| Applied Agent | `templateId` / `templateName` |
| Agent identity / stable behavior | `systemPrompt` plus optional template context |
| Agent default runtime/tool | `tool` on the saved app/template |

Compatibility note:

- first-party owner sessions still use the canonical source id `chat`
- that is a source compatibility key, not proof that the session's Agent is also `Chat`

## Creating an Agent

The intended user flow is:

1. Open the top-level **Agent** panel.
2. Start **Create Agent**.
3. Describe the workflow in plain language.
4. Let the builder session synthesize the reusable Agent definition.
5. Reuse that Agent for later sessions.

The builder should gather only the minimum missing information and then create or update the saved Agent record.

The user should not need to manage raw fields such as:

- `welcomeMessage`
- `systemPrompt`
- `templateContext`
- `shareToken`

Those remain implementation details unless the user explicitly asks.

## Sharing

The current sharing model is intentionally lightweight:

- every shareable Agent carries a `shareToken`
- owner-side CRUD uses `/api/agents`
- public entry uses `/agent/{shareToken}`
- opening that link creates a fresh visitor-scoped session under that Agent

The important boundary is:

- the link grants access to one Agent
- it does not grant owner access
- it does not expose other sessions outside the visitor-scoped session created from that Agent

## Design constraints

When designing or refining Agents, keep these constraints:

- do not rely on generic chat history alone to preserve identity
- keep stable agent behavior in reusable saved fields, not only in transient conversation
- do not mix source/channel logic into the Agent definition
- do not bury Agent management inside Settings
- keep first-run creation conversational and low-friction
