# Feishu mainline routing latency and reaction feedback

Status: latency retrospective and implementation work. Source verification,
deployment and natural-message acceptance are separate outcomes.

## Observed problem

A three-message device-research discussion was received in under 0.7 seconds
per message. The initial mainline execution lasted 262.603 seconds before it
finished. Its six visible tool batches covered 14.982 seconds; the remaining
time lies before/between tool batches and cannot be split into pure model
reasoning, provider wait and runtime scheduling from retained records.
Later inputs waited 270.605 and 342.877 seconds from admission to run start.
The first 27.979-second preparation span lacks per-function timing.

The existing durable inbox, detached Runs and outbox already decouple receipt,
execution and sending. Two sequential boundaries remain: input preparation per
conversation, and complete Harness turns on the routing-pilot mainline. The
mainline inspected device evidence before selecting a work topic. Asynchronous
transport does not eliminate this work or the queue behind it.

## Research and preferred order

[Anthropic's routing pattern](https://www.anthropic.com/engineering/building-effective-agents)
separates classification from specialized work and emphasizes starting simply
and measuring the latency/quality tradeoff.
[LangChain's router documentation](https://docs.langchain.com/oss/javascript/langchain/multi-agent/router)
distinguishes a lightweight routing step from a conversational supervisor, and
explains that multi-turn routing needs persisted history and selective context.
These are patterns, not measured latency guarantees for RemoteLab. No framework
or new semantic supervisor is required to adopt the useful boundaries.

1. Bound the mainline decision to message relationship, task destination, reply
   destination and reply form. Use the latest discussion, the injected bounded
   active-topic list, source identity and participation/authorization snapshot.
   Allow a bounded metadata lookup when attribution is unclear; defer device,
   code, paper and business investigation to the work topic. Strict-start
   checks remain necessary, but evidence needed to choose a destination differs
   from evidence needed to execute the work.
2. Reserve a stable topic, admit the packet, and release the mainline promptly.
   Compatible accepted human inputs may steer the running pilot mainline;
   arrival in one execution does not imply membership of one business task.
   The Harness selects each input's handoff or local answer explicitly. Keep
   source identity, per-input receipts and reply ownership; do not inherit a
   routed root input's final answer for an unrelated follow-up. Do not add a
   fixed wait to collect consecutive messages.
3. Move receipt feedback off context/attachment preparation. Read-only status
   questions can use persisted received/queued/running state; deeper diagnosis
   continues in a work topic. A status reply must not imply work completion.
4. Measure a smaller/faster mainline context and lower reasoning setting only
   after bounding the job. Keeping the same multi-step investigation on a
   faster model does not remove the dependency chain. Cache stable background
   and topic metadata; revalidate changing authorization and destination state.
5. Consider merging participation/relationship/reaction into the existing
   lightweight call only if replay demonstrates adequate attribution. Adding
   another classifier followed by the current Harness repeats the decision.
   A dedicated router is an experiment requiring the thin-control-plane gate,
   not the default architecture or this task's shipped change.

## Validation before a latency rollout

Compare the baseline, bounded mainline, and bounded mainline with a smaller
runtime on the same timestamped cases. Measure receive-to-feedback,
receive-to-destination-admission and receive-to-first-useful-reply separately.
Record preparation, classifier, runtime startup, decision, handoff, outbox
claim and provider acknowledgement spans. Report p50/p95 and the worst cases.

Include same-author supplements, two people and two concurrent matters, an
archived destination, quoted requests, explicit mentions of another person,
stops/corrections, attachment-plus-text, ambiguous references, lost admission
acknowledgements, restart/retry and changed participation state. Check wrong
topic, duplicate task, missing receipt, wrong reply location, and unauthorized
cross-topic operations as well as speed. A three-message case is a regression
example, not a distribution or general accuracy benchmark.

Suggested initial trial targets (not achieved measurements): feedback p95 <=2s,
destination admission p95 <=10s, status response p95 <=5s. Include upstream
and startup wait in these targets. Preserve all hard ownership cases and compare
relationship accuracy with the baseline; do not accept faster wrong routing.
Begin with isolated replay and then the existing authorized single-group scope.

## 2026-10-09 retrospective

The October 8 pilot disabled mainline steer to prevent shared-result settlement
from treating unrelated inputs as one reply. The explicit dispatch guard and
its introduction comment confirm a compatibility precaution, not an observed
native transport failure. This addressed reply ownership by serializing entire
turns, introducing head-of-line waiting for supplements and status questions.

Three independent waits need different changes:

- Accepted input to active execution: remove the pilot-only serialization when
  both inputs use the per-input pilot contract; keep runtime, question, internal
  operation, document and confirmed reconsideration boundaries.
- Mainline decision: use bounded destination/status metadata and defer device,
  repository and business research. Do not make a second deep investigation
  merely to decide where the investigation should run.
- Input preparation: receipt ordering was improved in the reaction slice, but
  attachment/background preparation remains a separate dependency. The observed
  27.979-second gap cannot be attributed more precisely from existing evidence.

An explicit local reply must use the saved input address and enter the durable
outbox without waiting for the whole execution to end. Topic handoff and local
reply are mutually exclusive for an input. Retries must preserve the same text
and input set. Missing per-input handling must remain visible as incomplete,
never be silently marked answered with a different input's final payload.

The implementation permits compatible pilot inputs to steer one execution and
adds `work reply` for an explicit local answer. A root-reserved reply packet and
per-input outbox commits allow terminal recovery after interruption. The pilot
settlement uses each input's handoff or selected answer; other conversations
retain the existing shared-final behavior. A status nudge no longer inherently
requires a full investigation in the lightweight placement prompt. These prompt
changes still need natural-message evaluation; isolated tests prove transport
and state contracts, not model compliance or reasoning speed.

The historical 270.605/342.877-second admission-to-start spans include startup;
removing the dependency is not a measured promise to save that exact duration.
Isolated held-run replay can prove concurrent delivery, correct ownership and
recovery. It cannot prove real-model routing accuracy or production p95 latency.

## Reaction slice

The curated catalog contains 50 built-in IDs verified against the
[official Lark CLI reaction reference](https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-reactions.md).
Legacy final directives and the outbox share this catalog. The existing quick
decision call can select 40 social/receipt reactions, alongside participation
and placement; it does not add a model call. Completion/verification and binary
claims remain outside tone selection.

Get means received/accepted and fits a request whose answer continues elsewhere.
It does not prove handoff by itself. Successful topic admission separately
queues a Get receipt for each original input; admission failure never produces
that success-stage receipt. The work answer stays in its saved topic.
Selected social reactions survive text-reply decisions. Feedback is queued
without waiting for attachments/context submission, and its failure does not
discard work admission. This improves feedback dependency ordering, not the
minutes-long semantic routing itself.

The connector persists its own outcome reaction IDs. A new success receipt
precedes deletion of its prior reaction; cleanup retries survive restart.
Older initial feedback cannot overwrite a newer routing-stage reaction. Other
people's reactions are never removed. Changing production process versions and
observing a natural group message are separate delivery checks.
