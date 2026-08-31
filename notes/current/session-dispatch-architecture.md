# Session Continuation Routing Architecture

Status: retired from the active runtime.

RemoteLab no longer performs a pre-turn semantic continuation gate or planner. Normal messages go directly to the selected Harness after structural validation and busy-session queueing. A Harness may explicitly create a persistent RemoteLab child session when that separate session has concrete value.

Current boundary: `notes/current/thin-control-plane-architecture.md`.

Historical two-stage design: `notes/archive/session-dispatch-architecture.md`.
