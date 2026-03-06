# Creating Apps — Let Others Use Your AI Workflows

Apps let you package an AI workflow and share it via link. Anyone who clicks the link gets a guided chat experience — no setup, no technical knowledge needed.

## What Is an App

An App = a chat session that starts with context you've pre-defined.

When someone opens your App link:
1. They see a **welcome message** you wrote (greeting + instructions)
2. Behind the scenes, the AI receives **system instructions** (workflow rules, what to do, how to behave)
3. They chat naturally — the AI follows your workflow

The visitor doesn't need to know anything about prompts, tools, or configuration. They just talk.

## How to Create an App

Open a regular session in RemoteLab and tell the AI:

> "I want to create an App. It should [describe what it does]."

The AI will guide you through:
1. **Naming** the App
2. **Writing a welcome message** — what the visitor sees first
3. **Defining system instructions** — how the AI should behave
4. **Creating the App** — the AI calls the API and gives you a share link

### Example

> "I want to create an App that helps people practice English conversation. It should be friendly, correct grammar gently, and keep responses short."

The AI will draft the welcome message and system prompt, create the App, and return a link like:

```
https://your-domain.com/app/share_abc123...
```

Share this link with anyone. They click it, they're in.

## How to Manage Apps

In any regular session, you can say:

- **"List my Apps"** — see all active Apps with their share links
- **"Update the English Tutor App"** — modify welcome message or instructions
- **"Delete the X App"** — removes it (existing sessions keep working)
- **"Regenerate the share link for X"** — invalidates old link, creates new one

## Tips for Good Apps

1. **Welcome message should be actionable** — tell the visitor exactly what to do first
2. **System instructions should be specific** — "correct grammar gently" is better than "be helpful"
3. **Test it yourself** — click the share link in a private/incognito window before sharing
4. **Keep it focused** — one App = one workflow. Don't try to make a Swiss army knife

## Technical Details (for developers)

- Apps are stored in `~/.config/remotelab/apps.json`
- Each App has a unique `shareToken` used in the URL
- Visitor sessions are isolated — visitors can't see each other's conversations
- The owner's session list hides visitor sessions by default
- Share-link visitors are restricted to their assigned WebSocket session; owner APIs for sessions, tools, models, filesystem browsing, settings, sidebar state, and push registration stay unavailable to them
- Assistant output can wrap model-visible but UI-hidden content in `<private>...</private>` or `<hide>...</hide>`; RemoteLab hides those blocks in chat while preserving the raw text in session context
- App CRUD API: `GET/POST/PATCH/DELETE /api/apps` (owner auth required)
- Visitor entry: `GET /app/{shareToken}` (no auth needed)
