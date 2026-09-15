# Native follow-up queue state

## Problem and scope

Ordinary user input submitted while a native Harness is executing an internal
operation (including `trigger_delivery`) cannot join that operation. It remains
in the Session queue and is removable. Admission nevertheless returned
`queued: false` because it checked only the incoming request's internal-operation
flag. The active request's flag was absent from that decision.

The user requested only this state fix. Internal operations remain sequential;
scheduled Session selection, external conversation binding and delivery routing
are unchanged.

## Change

Admission and native dispatch now share `canForwardNativeRequest`, covering both
requests' internal-operation flags, fresh-thread requests, cancellation and
runtime compatibility. Admission also observes the active Run's cancellation
flag. Native input capability alone no longer implies that an input will steer.
Existing queue projection/removal continue to use the durable request state.
No persisted schema or additional scheduling mode is introduced.

## RED

The expanded native integration test failed on the original production code:

```text
AssertionError: user input behind an internal native operation must report queued
false !== true
```

The fixture holds an actual detached fake App Server turn while sending a user
follow-up through `submitHttpMessage`. It creates no production input or external
message. The test also checks normal native steering and rejection of removal
after native acknowledgement.

## GREEN and regression coverage

The new integration assertions pass for queued admission, Session detail,
response state, duplicate admission, controller restart, native receipt absence,
removal and replay without resurrection. Normal native steering, lost-ack replay
protection, one final publication and explicit rejection recovery remain covered.

The added restart case uses the production shutdown/drain path before replacing
the controller. An initial forced kill landed inside the existing directory-lock
mutation window and left a stale Run lock; that separate crash-recovery behavior
is not changed here. Existing forced-crash scenarios remain in the suite.

Full regression also exposed a pre-existing clock fixture error in
`test-session-auto-archive.mjs`: its frozen `now` was passed inside settings,
although the API accepts it in its third argument. Once the wall clock passed
the fixture's threshold, the assertion failed. The test now injects its clock
through the existing API; production auto-archive behavior is unchanged.

## Validation and deployment

- Full isolated `npm test`: PASS, exit 0.
- Queue runtime removal, real HTTP queue removal and browser-panel logic: PASS.
- `npm run test:restart-gate`: PASS.
- Syntax checks and `git diff --check`: PASS.
- `npm run lint:filesize`: PASS (existing large-file advisories).
- Held native integration: PASS for both ordinary steer and internal-operation
  queue state. Production activation is verified separately after commit.

Operator-local logs are retained under the workspace's
`remotelab-steer-audit-20260915/state-fix/` directory (`red.log`, `green-2.log`,
`full-2.log`, `checks.log`). The source checkout's existing unrelated edits are
preserved and excluded from this fix's commit.
