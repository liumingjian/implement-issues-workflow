# "Closed" means landed on the integration branch, not shipped

**Status:** accepted · **Date:** 2026-08-04

The planner re-judges dependencies live every round by fetching each `blocked_by` blocker's
current issue state (`workflows/implement-issues.js` — planner prompt, step 5a). An issue's
open/closed state is therefore the **only machine-readable "this dependency is satisfied" signal
the run has**. We decided that an issue is closed the moment its branch merges cleanly into the
integration branch *and* the post-merge full suite is green — not when the draft PR reaches the
base branch. The implement and review stages never close anything.

## Considered options

**Close when the draft PR merges into base.** Semantically truer — "closed" would mean "shipped".
Rejected because no issue would close during the run at all, so no `blocked_by` edge would ever
resolve, and the re-plan loop would collapse to `blocked` after its first round. The in-memory
`done` list covers this within one run but persists nothing across runs.

## Consequences

- **Closed ≠ shipped.** If you abandon the draft PR, you are left with closed issues whose code
  never landed. To make them recoverable without introducing new label discipline (see README,
  "Spec vs ticket by structure, not labels"), the merge stage's close comment is required to name
  the integration branch and the merge commit sha, so
  `gh issue list --state closed --search "auto/implement-2"` finds the whole set for reopening.
- **Re-running before merging the previous draft PR silently drops work.** Preflight always cuts a
  fresh integration branch off base, and the planner only lists open issues — so issues closed by a
  previous run are neither present in the new branch's history nor eligible for re-release. This is
  documented as a human precondition ("merge or discard the previous draft PR before re-running")
  rather than fixed by having preflight resume the newest `auto/implement*` branch: guessing which
  integration branch is still current can silently continue on a branch you had decided to discard,
  which is harder to notice than the documented precondition.
- **open/closed carries dependency semantics and nothing else.** Quality and progress information
  must travel as issue comments and PR body text, never as issue state. See
  [0002](./0002-review-failure-blocks-merge.md).
