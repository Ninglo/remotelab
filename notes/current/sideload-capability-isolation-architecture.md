# Sideload Capability Isolation Architecture

This note captures the current product/architecture direction for RemoteLab side-loaded capabilities such as attachments, voice ingress, local helper bridge flows, and media-capable external connectors.

## Why this note exists

RemoteLab already contains several classes of side-loaded capability:

- chat attachment ingress and asset delivery
- local helper / bridge staging and file return
- voice capture / STT / TTS flows
- media-capable connectors such as WeChat and mail attachments
- public edge and managed distribution surfaces tied to those capabilities

The key architectural question is not which of these feel "advanced". The real question is which of them require platform-owned secrets, public edge authority, third-party channel authority, continuous device/runtime responsibility, or separate billing/SLA accountability.

## Core judgment

The main Lab process should stay focused on the workbench itself:

- user-facing session UI
- conversation and orchestration flow
- asset references and result presentation
- capability invocation and audit-visible state

High-risk capability execution should move behind a separate managed capability layer or assistant service.

That capability layer may live on the same machine at first, but the design should assume it can live elsewhere later. The important separation is responsibility and secret ownership, not immediate physical deployment.

Each instance should be treated as a first-class principal in this model. The instance authenticates to the managed capability layer as itself, but it should not become the long-term holder of platform secrets.

This makes the capability layer more than a bag of helper scripts. It becomes the platform-owned tool plane for:

- upload signing and managed asset ingress
- voice ingress / STT / TTS execution
- local helper authority and pairing
- public-edge and extra-address allocation
- media-capable connector execution
- audit, billing, and entitlement enforcement across those capabilities

## What should remain in Lab core

The basic user affordance of attaching a file or image inside chat should remain part of the core workbench experience.

Likewise, unified asset references, result-file presentation, and share/delivery surfaces remain core because they are part of the normal task-completion loop.

## What should move into the managed capability layer

The sensitive machinery behind those user affordances should move out of the instance:

- upload signing and object-storage write authority
- public download / public edge allocation for managed assets
- extra Cloudflare/public-address assignment or equivalent managed routing
- long-lived third-party connector tokens
- voice pipeline control that carries device/runtime/cost responsibility
- local helper pairing/bootstrap authority and command trust boundaries
- media forwarding and external-channel attachment handling that carries compliance and retry responsibility

In short, the user may still see "upload", "voice", or "connector media" in the product, but the instance should not become the long-term owner of the secrets that power those capabilities.

## Secret-ownership rule

If a capability requires a long-lived platform secret, the user instance should not hold it.

Instead:

- the managed capability layer owns the master credential
- the instance requests a managed action
- the capability layer returns a scoped, short-lived token or action result
- audit and billing happen at the capability layer

This matters for security, revocation, rotation, tiering, and migration.

The preferred model is:

- instance identity is durable
- platform secrets are not
- action tokens are short-lived and scoped
- billing and audit attach to capability execution, not merely to chat turns

## Priority order

1. Unify capability, asset, and secret-ownership boundaries.
2. Isolate voice first.
3. Isolate local helper / bridge next.
4. Split media-capable connectors after that.
5. Move public-edge / extra-address allocation into the managed capability layer.

## Product consequence

This architecture supports cleaner commercial packaging:

- core workbench stays understandable and self-contained
- managed capabilities become billable, tierable, auditable product surfaces
- user instances stay cleaner and safer
- migration becomes easier because high-risk secrets do not travel with instance data

## Related artifact

- `/root/.remotelab/workspace/remotelab-sideload-capability-isolation-assessment-2026-04-14.md`
