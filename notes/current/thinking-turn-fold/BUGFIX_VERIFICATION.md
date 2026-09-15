# One thinking block per user turn

Date: 2026-09-15

## Cause

The server display projection used different grouping rules for running turns,
finished turns with a visible tail, unfinished/interrupted turns, and automatic
continuations. Unfinished turns fell back to segmenting hidden events around
visible events, including usage records. The frontend rendered each segment as
a separate Thought row.

## Change

`flushTurnInto` now uses one grouping path for every user-message turn:

- While running, fold the intermediate body into one block.
- Once the turn is closed, fold through its last reasoning/tool/context event
  into one block, with any final reply or trailing status visible afterward.
- New user input closes the previous block and starts a new turn. A turn without
  hidden work needs no block.
- Automatic continuation follows the same rule. Its earlier reply remains in
  the expandable history; the final continued reply stays outside.
- Existing attachment delivery and lazy body-loading paths are retained.

Removed segmented fallback and automatic-continuation special cases: production
diff is 9 lines added, 128 removed. Persisted history is unchanged.

## RED → GREEN

The interrupted-turn regression failed before the fix: four thinking blocks
were emitted around status, commentary and usage instead of one. The automatic
continuation regression also failed with two blocks instead of one.

After the fix, tests cover running, interrupted, user-steered, cancelled,
completed and automatically continued turns. Expanded block events retain their
original order; a block never absorbs the next user message. Existing attachment
and visible final-reply assertions pass.

## Verification

- Replayed the actual history behind the reported screenshot: **8 blocks → 1**,
  with all 52 non-ignored events preserved in its expandable range.
- Full `npm test` passed, including event-block loading, incremental rendering,
  default fold preferences, attachment handling and HTTP session regressions.
- `npm run test:restart-gate`, syntax and `git diff --check` passed.
- `npm run lint:filesize` exited 0 with pre-existing repository size warnings.

Runtime tests used isolated instance state. Unrelated working-tree edits were
preserved and excluded from this change. Live API verification follows deployment.
