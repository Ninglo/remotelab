# Session Dispatch And Direct Delivery Follow-ups

Status: dispatch portion retired; direct-delivery boundary remains active.

The pre-turn session-dispatch stack, checking queue, and continuation planner were removed. Normal messages now enter the selected Harness directly. Persistent child sessions remain an explicit Harness-invoked capability.

Deterministic outbound work must still use direct connector delivery when the outcome is already known and no AI reasoning is required. Session injection remains reserved for work that actually needs a Harness run or conversation continuity.

Current runtime boundary: `notes/current/thin-control-plane-architecture.md`.

Historical dispatch/direct-delivery backlog: `notes/archive/session-dispatch-and-direct-delivery-followups.md`.
