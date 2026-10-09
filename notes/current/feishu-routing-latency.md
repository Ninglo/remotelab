# Feishu mainline routing latency and reaction feedback

Status: routing optimization research; reaction/feedback implementation is
verified separately from deployed processes and natural-message acceptance.

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
   Reuse existing scoped routing, per-input IDs and native follow-up receipts.
   Do not forward every new group message into the running turn: multiple
   people, new matters, stop requests and different reply locations need their
   own ownership. Do not add a fixed wait to collect consecutive messages.
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
