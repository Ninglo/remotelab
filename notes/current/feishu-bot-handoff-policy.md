# Per-instance Bot handoff admission

Existing installations may intentionally use peer Bots as repeated task triggers.
A receiving-connector source patch for this behavior diverges across releases.
`botHandoffPolicy` now expresses that instance choice in configuration, so all
instances can run identical mainline source.

- Default: `once_per_session`, retaining durable shared admission and loop limits.
- Opt-in: `unlimited`, allowing repeated explicitly addressed Bot inputs while
  preserving self-message suppression, sender access control and ordinary routing.
- Switching policies never clears historical quota records. Re-enabling the
  default preserves previously consumed thread allowances.

Validation: the config/behavior regression failed before implementation because
`loadConfig` discarded the policy. It passes with the change, including repeated
admission after runtime reconstruction, unchanged thread routing, self/unmentioned
message rejection, invalid-config rejection and retained old quota on restoration.
The complete `npm test`, file-size lint and `git diff --check` passed.

Operational deployments must preserve any prior explicitly approved trigger-only
behavior using instance configuration before replacing a locally patched source.
