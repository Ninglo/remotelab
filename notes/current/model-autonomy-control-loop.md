# Model Autonomy Control Loop

Status: retired from the current architecture.

The former RemoteLab-owned turn-close self-check, automatic continuation, and semantic delegation design was removed during the thin-control-plane refactor. The selected Harness now owns planning, decomposition, self-review, and continuation inside the task run.

Current boundary: `notes/current/thin-control-plane-architecture.md`.

Historical design: `notes/archive/model-autonomy-control-loop.md`.

2026-10-22: an explicit personal opt-in now projects a bounded delivery check into the current Harness before its final answer. It is off by default and does not restore the retired supervisor or continuation loop. See [delivery self-review](../../docs/session-work-awareness.md#可选交付前自检).
