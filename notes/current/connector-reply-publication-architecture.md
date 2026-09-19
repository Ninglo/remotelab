# Connector Reply Publication Architecture

Status: simplified after removal of reply self-check / automatic repair.

A normal Harness Run now owns one reply publication lifecycle. Publication becomes `ready` when that Run completes and result assets are published; it becomes `failed` or `cancelled` with the Run terminal state. Connectors no longer wait for a hidden reply-review or continuation Run.

Historical multi-run publication design: `notes/archive/connector-reply-publication-architecture.md`.

Current boundary: `notes/current/thin-control-plane-architecture.md` and `docs/external-message-protocol.md`.

Session metadata now owns optional external conversation bindings. Requests
snapshot either the binding or an explicit in-scope current-message destination
and commit results and outbox parts together. Native inputs consumed in one turn publish one answer.
The first Feishu receipt binds a new group publication to its root; later
output uses that topic. Browser and scheduled input share this same path.
See [Session conversations](session-conversations.md).
