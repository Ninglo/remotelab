# Product Mainline + Feedback Loop

Status: current operating plan as of 2026-03-26

Directional companion: `notes/directional/product-vision.md`

Execution companions:

- `notes/current/session-main-flow-next-push.md`
- `notes/current/session-dispatch-and-direct-delivery-followups.md`
- `notes/current/session-first-workflow-surfaces.md`
- `notes/current/session-first-product-contraction.md`
- `notes/current/knowledge-layers-and-connectors.md`
- `notes/current/instance-scoped-connectors.md`
- `notes/current/connector-state-surface.md`

Evidence log: `notes/current/user-feedback-log.md`

## Why this note exists

- The product headline has already been reset toward mainstream guided automation, but the repo still needs a short current operating plan for day-to-day prioritization.
- The existing near-term implementation notes describe important capability work, but they do not by themselves explain how that work should be selected or re-prioritized.
- User feedback should not live only in private memory or scattered chats; durable product evidence should stay visible in repo notes so human and AI collaborators can align on the same facts.

## Current mainline

- Keep finding real users with repetitive digital work and observe the language they naturally use.
- Use onboarding, support, and product-review conversations as product discovery, not just as one-off troubleshooting.
- Optimize for one concrete automation win: take one recurring digital chore from a vague description to a trusted result on a real machine.
- Let repeated user evidence outrank internally elegant abstractions when the two conflict.
- Keep knowledge layering and execution connectors separate: shared toolchains and connectors may stay common, while domain knowledge stays retrievable and user context stays private.
- When local domain coverage is thin, strengthen the local knowledge layer and reusable local skills first instead of introducing cloud lookup, upload, or third-party domain-provider flows.
- Prefer owner sessions plus read-only share snapshots over product-facing `App` / `User` abstractions during the current simplification phase.
- Treat multi-session orchestration, context carry, reusable packaging, and other higher-order capabilities as support layers unless user evidence clearly pulls them forward again.

## Working loop

1. Find or recruit a real user or repetitive-work case.
2. Capture the job to be done, current workaround, constraints, and success bar.
3. Run the workflow in RemoteLab or simulate the intended flow with enough realism to expose friction.
4. Record where the user gets stuck: language, onboarding, trust, delivery, approvals, review, or missing capability.
5. Convert repeated signals into product judgments, wording changes, or implementation priorities.
6. Validate the updated flow with the next users and keep tightening the loop.

## Feedback asset rule

- Meaningful user feedback is a durable product asset, not disposable chat residue.
- Keep reusable feedback in repo-visible notes rather than only in machine-local memory or hidden AI context.
- Prefer sanitized summaries and extracted signals over raw transcripts.
- Keep personal identifiers, secrets, and sensitive raw material out of shared notes.
- When feedback changes the product promise, target user slice, current main flow, or push priorities, update the relevant canonical doc instead of leaving the insight only in a log.

## Shared surfaces

- `notes/current/user-feedback-log.md` — running evidence log
- `notes/current/knowledge-layers-and-connectors.md` — current working shape for base/domain/user knowledge plus shared connectors
- `notes/current/instance-scoped-connectors.md` — current product truth for connector bindings, delivery identity, and side-effect isolation
- `notes/current/connector-state-surface.md` — generic capability/delivery state contract and email-to-connector migration path
- `notes/directional/product-vision.md` — durable product judgments and target-user framing
- `README.md` / `README.zh.md` — user-facing product promise
- `notes/current/session-main-flow-next-push.md` — near-term capability push
- `notes/current/session-first-workflow-surfaces.md` — workflow-organization baseline for session-first surfaces

## What is worth logging

- repeated repetitive-work categories users actually want automated
- moments where users do not know how to ask for help
- onboarding language that fails or creates false expectations
- trust, review, approval, or delivery blockers
- evidence about which user slice has the strongest pull
- requests that show when background orchestration should stay hidden or become more visible
- changes in willingness to pay, adopt, or reuse the workflow

## Minimal entry shape

- date
- source or context
- user slice
- recurring job
- observed friction or request
- why it matters
- implication for product, docs, or implementation
- follow-up status

## Priority test

- The current session-first, context-freshness, and fan-out work still matters, but it should be judged by whether it helps real users reach the first trusted automation win faster.
- If future feedback says a simpler onboarding, stronger review loop, or better result delivery matters more, those items should outrank elegant orchestration work.
- "Can a normal user hand off repetitive work quickly and trust the result?" is a better top-level priority test than "Can the system demonstrate impressive orchestration?"
