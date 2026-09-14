# Session auto archive

Archive is a visibility state for the sidebar. It does not block work or
change a Session's connector binding. When a browser or connector submits a
new message to an archived Session, admission clears `archived` first and the
existing request path continues normally.

The owner can select `Off`, `12 hours`, `24 hours`, `3 days`, or `7 days` in
Settings. The default is `Off`. The server checks every 15 minutes and uses
the latest user message timestamp, falling back to session creation for an
empty Session. Pinned, running, queued, visitor, and internal Sessions are
left visible. Archive never deletes history.
