# Retired Global Manager Prompt Policy

RemoteLab previously injected a global manager policy at startup, a Codex-specific developer-instruction copy, and a similar reminder on every turn. That design duplicated Harness behavior and allowed small wording changes to accumulate into a conflicting hidden policy stack.

The global behavioral layer is retired. RemoteLab now projects runtime facts, capabilities, memory pointers, provider-neutral work state, and explicit session state. Codex receives no RemoteLab developer instructions by default; operators can still set an explicit runtime override when they intentionally want one.

`activeAgreements` remains supported because it is explicit session state, not a global RemoteLab house policy. Agreements are scoped to a concrete session and can be changed or cleared there.

Access control, connector bindings, visitor scope, persistence, and delivery remain RemoteLab responsibilities, but their authority must come from code and structured state. Prompt text may describe the resulting role or capability; it must not become a parallel enforcement system.

See `notes/current/prompt-layer-topology.md` for the current projection contract.
