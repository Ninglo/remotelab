# Randomized feature experiments and nightly case review

Status: design contract, 2026-10-13. The implemented first slice is documented
in [feature experiments](../../docs/feature-experiments.md). Live activation is
instance-local and must be read from its configuration. The requester selected
the earlier automatic-background policy versus current on-demand reads, limited
to their newly created Sessions; automation is a separate later integration.
This document includes future analysis/calibration goals, not all shipped claims.

## Purpose and first application

Compare real task outcomes under two feature versions, retaining a probability
sample for bounded nightly review. Reuse the same records and workflow for later
features. The first candidate is context delivery; see
../../docs/connector-turn-context.md for the existing implementation and its
small-sample validation. Existing monitoring and Schedule primitives are reusable;
neither currently constitutes this experiment system.

## Randomization and analysis

- Define eligibility, control/treatment revisions, assignment unit, sampling
  probability, outcome window, primary metrics, acceptable quality loss, serious
  incident rules, review checkpoints and resource limits before activation.
- Draw an independent fair random assignment when an eligible unit first enters,
  then durably retain it before exposure. Labels never influence assignment.
  Retries and controller restarts reuse the assignment; failed persistence must
  not silently redraw or claim randomized exposure.
- Context experiments use fresh Sessions as assignment units. Each automatic
  task needs a separately specified unit and carry-over policy. Never alternate
  strategies within a continuing context merely to balance group counts.
- Record assigned and actually applied strategy, including fallback, failure to
  apply, mixed participants and version changes. Primary analysis keeps assigned
  units, including failures and fallbacks, in their original group.
- Sample independently of arm and outcome at admission. Preserve all lightweight
  denominators; retain the selected cases' necessary evidence. Additional incident
  cases belong to a diagnostic set, not the probability-sample success rate.
- Primary reporting uses all randomly sampled units. Label-matched views are
  secondary and must show unmatched and unknown-label counts. Sparse labels do
  not justify discarding difficult cases or claiming equivalence.
- Labels may be produced after randomization, but only from a frozen pre-exposure
  evidence packet. Hide assignment, outcome, cost and execution trace from the
  labeler. Future user clarifications can themselves be treatment effects and
  must not redefine baseline labels.
- Use a small versioned vocabulary: requested work type, initial material size,
  input modality and requested external-write requirement. Later failure type,
  retries, duration and observed difficulty are outcomes/diagnostics, not matching
  variables. Missing information stays unknown.
- Freeze strata and comparisons before seeing scores; report task/Session-level
  uncertainty, sample imbalance and missingness. Repeated turns are not independent
  assignments. Changes during the experiment create new analysis epochs.
- Shared memories and other concurrent feature changes can contaminate groups.
  Record relevant versions; exclude evaluation outputs from automatic learning
  and do not overlap experiments on the same mechanism in the initial version.

## Four versioned record types

1. Experiment: eligibility, assignment unit, feature revisions, lifecycle,
   measurement/rubric versions, sampling policy, stopping and review rules.
2. Case: immutable initial evidence, assignment reference, task/Session/Run links,
   material/trace/outcome references, observation cutoff, coverage and sampling
   probability. Store necessary snapshots and hashes instead of copying everything.
3. Rubric: common outcome criteria plus feature-specific checks, evidence needed,
   deterministic validators, model judge profile/prompt, vocabulary and calibration
   examples. Model-generated acceptance criteria are provisional unless grounded
   in the actual request or an independently supplied task contract.
4. Evaluation: case evidence hash, rubric/judge versions, criterion-level verdicts
   and evidence locations, missing evidence, diagnostics, human corrections and
   measured scoring cost. Never overwrite an earlier evaluation after new evidence.

Cases are bounded task episodes; their boundaries and observation cutoff need an
explicit rule. Interrupted, cancelled, failed and timed-out work remains visible.
Late feedback produces a new observation version. No feedback is not acceptance.

## Nightly review

Use an existing native Schedule and fresh evaluation context. A deterministic
gate selects new eligible evidence versions within an explicit batch/runtime/
resource budget. No new foreground classifier or permanent AI polling loop.

Run deterministic checks first, then a blinded model review of semantic criteria.
Labels and scores use separate input packets; outcome text must never enter the
label packet. Treat retained case content as evidence, not executable instructions.
The reviewer does not rerun business writes, contact users or change feature flags.

Each criterion is pass, partial, fail or insufficient-evidence, with source
locations and reasoning. Separate verified external outcomes, model judgments and
explicit human acceptance. Do not compress serious violations into an average
quality score. Result-shaped JSON validates structure, not the truth of judgments.

Use a durable claim/lease and an idempotency key from experiment, case evidence,
rubric and judge versions. Only successful terminal evaluation commits results;
failed attempts retain drafts and leave the batch pending. Show backlog, skipped
records, coverage gaps and scoring costs. Admission limits and observed-token
budgets are not provider-enforced hard token caps.

A nightly report shows assigned/exposed/sampled/evaluated counts by arm, waiting
and unscorable cases, objective outcomes, semantic judgments, human interventions,
latency, measured usage, fallback and incidents. Tag views are appended to the
overall comparison. No automatic promotion from a nightly winning score.

## Initial rollout and acceptance

1. Calibrate on a small retained set containing success, failure, unsupported
   completion claims and missing evidence; compare judge conclusions with manual
   evidence review. Keep calibration separate from held-out evaluation cases.
2. Run an A/A pipeline check: both arms apply the same safe implementation. Verify
   durable randomization, eligibility, independent sampling, missingness, isolated
   judge inputs and trace/result linkage. Small A/A samples only expose gross bugs.
3. Enable the selected A/B strategies for the explicitly selected audience. Review
   serious incidents promptly and assess effect sizes/uncertainty at predeclared
   checkpoints. Absence of a significant difference is not non-inferiority.

Before live use, verify crash/retry idempotency, wrong-person and old-Session
exclusion, actual strategy receipts, control behavior retaining correctness fixes,
label independence, grader evidence validation, partial records, failed Schedule
recovery, cost visibility and disable behavior. Disabling new admissions must not
erase records or silently relabel already exposed Sessions.

Data retention follows an explicit instance-local policy and existing access
boundaries. Preserve sufficient evidence for disputed cases without creating a
second project knowledge ledger or an unbounded copy of every conversation.

## References

- https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
- https://arxiv.org/abs/2306.05685
- https://arxiv.org/abs/2406.12045
- https://arxiv.org/abs/2410.10813
