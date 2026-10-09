# Feishu thread reply participation fences

## Incident and feedback

On 2026-10-09 a group discussion reported that useful intermediate findings
were hidden and then asked where the promised final answer was. Both final
answers existed in the execution history, but the connector cancelled them
with `Group participation is active; stale=true`. The provider thread contained
the opening, a progress card, and the human follow-ups, without either final.

The initial input used the mainline participation epoch (2). After its opening
learned a provider thread ID, delivery compared that epoch with the independent
thread epoch (0). A later thread input correctly captured epoch 0, but outbox
refinement replaced its target with the Session root's epoch 2 and root anchor.

## Change and validation

- Capture the participation source scope and source message when building each
  request's delivery target, including a mainline request opening a thread.
- Learn missing thread aliases without replacing the request's inbound anchor
  or participation fence with Session metadata.
- The real outbox/connector regression covers opening, final, and follow-up
  delivery with different mainline/topic epochs. It also verifies that actual
  destination pauses and stale source/topic epochs still suppress publication.
- Unit coverage verifies target construction and immutable request refinement.

The separate intermediate-finding example was ordinary unmarked commentary.
Public progress remains an explicit Harness surface and follows the sender's
confirmed reply choices. This repair does not expose internal commentary or
change personal choices. Checklist-free progress cards and one durable final
remain covered by `tests/test-person-message-replies.mjs`.

Tests use isolated instance state and mocked provider sends. Deployment and
recovery of the original thread require separate live verification.
