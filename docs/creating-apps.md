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

RemoteLab now ships two starter Apps out of the box:

- **Create App** — a built-in app-building assistant; the sidebar `New App` button opens a fresh session scoped to this starter
- **Video Cut** — a built-in review-first video editing app that can be shared directly for upload + cut-planning flows

Open a regular session in RemoteLab and tell the AI what App you want in one concentrated message so it can do most of the work without repeated back-and-forth:

> "I want to create an App. It should [describe what it does]."

The best pattern is that the AI gathers the missing details early, then drafts and creates the App with minimal interruption. It will guide you through:
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
3. **Treat saved templates as snapshots** — if you reuse a session as a template, refresh it when the underlying project context changes a lot
4. **Test it yourself** — click the share link in a private/incognito window before sharing
5. **Keep it focused** — one App = one workflow. Don't try to make a Swiss army knife

## Technical Details (for developers)

- Apps are stored in `~/.config/remotelab/apps.json`
- Each App has a unique `shareToken` used in the URL
- Saved session templates carry source-session freshness metadata so RemoteLab can warn the model when the original source session has drifted since capture
- Visitor sessions are isolated — visitors can't see each other's conversations
- The owner's session list defaults to owner-only, but the owner can opt into an all-users view when they need to inspect shared-app sessions
- Share-link visitors are restricted to their assigned WebSocket session; owner APIs for sessions, tools, models, filesystem browsing, settings, sidebar state, and push registration stay unavailable to them
- Assistant output can wrap model-visible but UI-hidden content in `<private>...</private>` or `<hide>...</hide>`; RemoteLab hides those blocks in chat while preserving the raw text in session context
- App CRUD API: `GET/POST/PATCH/DELETE /api/apps` (owner auth required)
- Visitor entry: `GET /app/{shareToken}` (no auth needed)
