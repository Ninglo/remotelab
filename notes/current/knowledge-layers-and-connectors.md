# Knowledge Layers And Shared Connectors

Status: current working product note as of 2026-03-28

Companions:

- `notes/current/product-mainline.md`
- `notes/current/user-feedback-log.md`
- `notes/directional/product-vision.md`
- `docs/shared-tools.md`
- `docs/external-message-protocol.md`

## Why this note exists

- Recent product discussion kept revisiting two different questions at once: what the system knows and what the system can do.
- Keeping those axes separate lets RemoteLab stay simple in the current single-machine phase without turning host-specific execution details into long-term product truth.
- This note captures the current working model so future implementation work does not mix shared tools, domain knowledge, and user-private context into one layer.

## The two-axis model

- **Knowledge axis**: `base agent -> domain layer -> user layer`
- **Capability axis**: shared execution connectors such as email, calendar, IM, docs, browser, CRM, and file utilities
- A task is the combination of the right knowledge stack plus the right permissioned connector surface.
- Having access to a connector does not imply the right to write into shared knowledge or private memory.

## Knowledge layers

### Base agent

- Same default foundation for every user.
- Holds reasoning scaffolding, memory extraction rules, context routing, tool invocation contracts, safety policy, and writeback discipline.
- Does not hold domain packs, user-private facts, company documents, account credentials, or third-party tokens.

### Domain layer

- Shared knowledge that may help multiple users inside one industry or workflow family.
- In the near term this can stay very simple: a predictable folder or knowledge-base path on disk that the model knows how to search.
- Good contents: terminology, role maps, metric dictionaries, common workflow skeletons, analysis frameworks, review checklists, and reusable skill candidates.
- Bad contents: raw company data, copied private documents, full transcripts, or unredacted case studies.
- Promotion rule: only abstracted, de-identified patterns should move into the shared domain layer.

### User layer

- Private long-lived context for one user, team, or company.
- Good contents: organization-specific terms, recurring projects, stable preferences, local workflow quirks, document indexes, and persistent working context that improves future judgment.
- Temporary scratch state should not automatically become long-lived user memory.
- User-layer material stays private by default and should remain cleanly separable from shared domain assets.

## Capability surface

- RemoteLab can expose one shared reusable connector/tool surface even in the current single-machine phase.
- The toolchain is shared; each concrete user or instance only configures the specific credentials, scopes, or account bindings needed for that connector.
- Early examples include mail, calendar, IM, docs, browser flows, CRM, and file-processing utilities.
- These are execution surfaces, not knowledge layers.
- Authorization, revocation, scope, and audit should stay independent from memory writes and domain promotion.

## Local reusable skills

- Reusable workflow knowledge should live locally first: on-disk skills, prompts, scripts, checklists, and domain notes that the agent can inspect and reuse on this machine.
- If local coverage is thin, the next move is usually to improve those local assets or gather task-specific evidence inside the current session, not to add a cloud skill registry or third-party domain dependency.
- Local reusable skills are execution helpers, not automatic knowledge writeback paths; private user material still should not silently promote into shared domain assets.
- Keep the skill abstraction simple for now: local discovery, local reuse, and explicit curation by the operator or agent.

## Near-term implementation bias

- Do not overbuild skill pull/upload flows, marketplace packaging, or a full hosted account system first.
- Do keep data cleanly separated now so migration remains possible later.
- Reuse one common connector surface across users instead of cloning tool logic per instance.
- Let the domain layer begin as a retrievable local knowledge folder before designing any heavier distribution system.
- Keep secrets and tokens out of user memory and out of shared domain notes.

## Practical rules

- `Base agent` is platform-owned and changes through product/runtime updates.
- `Domain layer` is shared only after abstraction and redaction.
- `User layer` is private by default and portable for that user.
- `Connectors` use least-privilege scopes and do not get implicit write access into shared knowledge.
- A successful user workflow may generate a domain candidate, but not a direct automatic promotion.

## What this means right now

- It is fine that RemoteLab currently runs on one machine.
- The early goal is not “fully migratable architecture now”; it is “cleanly separable data and reusable toolchains now.”
- The simplest near-term shape is:
  - one shared connector/tool surface
  - one retrievable domain-knowledge location
  - one private user-context layer
- That keeps the team free to keep shipping case by case while avoiding a future cleanup where machine-local hacks become product truth.
