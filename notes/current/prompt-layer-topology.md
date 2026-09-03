# Prompt Projection Boundary

## Core stance

RemoteLab is a substrate above several capable Harnesses, not another semantic Harness.

Its prompt projection exists to tell the selected Harness facts that only RemoteLab can supply. It must not recreate task interpretation, planning, safety policy, execution judgment, self-review, reply style, or permission heuristics already owned by the Harness and the current user context.

## What belongs in the projection

- runtime and source identity, including an authenticated owner or share-link visitor role
- code-backed instance and authorization scope
- available RemoteLab capabilities and their invocation syntax
- connector identities and binding-scoped actions
- user-reachable artifact and delivery protocols
- memory/context pointers
- provider-neutral work state, explicit session agreements, and continuation material
- Agent template instructions explicitly chosen for the session

These are projections of product state or capability. Prompt text is not their source of truth.

## What does not belong

- a RemoteLab persona or house reply style
- generic instructions about when to continue, clarify, plan, split, or self-review
- generic secret, credential, filesystem, or content-handling policy for owner sessions
- copies of provider-native developer instructions or safety rules
- a shared startup-defaults bundle of cross-user behavior preferences
- per-turn manager reminders that repeat the same behavioral advice

When a rule is an actual access invariant, code must enforce or structurally expose it. A short role/scope fact may still be projected so the Harness can reason with the boundary, but prose must not pretend to be the enforcement layer.

## Current projection layers

1. `chat/system-prompt.mjs` renders a small first-turn capability and context map.
2. `chat/turn-context-hook.mjs` reprojects only stable pointers, explicit agreements, and current work state on later turns.
3. `chat/session-manager.mjs` adds source, Agent, continuation, and visitor-role context when applicable.
4. Provider adapters invoke the Harness without a RemoteLab-owned developer-instruction default. An explicit operator override remains available.

## Stability gate

Every proposed always-on prompt line should answer: “What RemoteLab state or capability would the Harness otherwise be unable to know?”

If there is no concrete answer, the line belongs in user memory, an Agent template, repo-local instructions, an on-demand skill, or nowhere. Tests should assert both the facts that must remain and the behavioral policy blocks that must stay absent.
