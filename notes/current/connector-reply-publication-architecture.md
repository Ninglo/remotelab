# Connector Reply Publication Architecture

Status: simplified after removal of reply self-check / automatic repair.

A normal Harness Run now owns one reply publication lifecycle. Publication becomes `ready` when that Run completes and result assets are published; it becomes `failed` or `cancelled` with the Run terminal state. Connectors no longer wait for a hidden reply-review or continuation Run.

Historical multi-run publication design: `notes/archive/connector-reply-publication-architecture.md`.

Current boundary: `notes/current/thin-control-plane-architecture.md` and `docs/external-message-protocol.md`.
