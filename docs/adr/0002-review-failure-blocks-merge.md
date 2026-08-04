# A failed review blocks the merge, even though the build is green

**Status:** accepted · **Date:** 2026-08-04

A build that reaches the review stage has already passed the full suite twice (the per-ticket gate
inside its worktree, and it would pass again post-merge). We nonetheless decided that if the review
agent does not return `status: "success"`, the branch is **not merged**: the issue takes a `bump()`
exactly like a build failure, stays open, and returns to a later round — set aside after `k = 2`.
The previous behaviour merged the gated build anyway and closed the issue.

## Considered options

**Merge anyway, and note "review incomplete" in the close comment and PR body.** Higher throughput,
and the code demonstrably passes its tests. Rejected because the axis being skipped is
`/code-review`'s **Spec** axis — did this deliver what the ticket asked? The planner deliberately
releases an API producer before its consumers, so an unreviewed producer with a wrong interface
becomes the foundation the next round's consumer is written against. The consumer's own review only
inspects the consumer's diff against the integration tip, so the original mistake is never looked at
again, and the suite stays green because the same agent wrote the tests from the same wrong reading.
Defects compound fastest exactly where this failure mode bites: upstream of a dependency chain.

**Do not close the issue, but merge the code anyway.** Rejected outright — it makes issue state lie
about dependency satisfaction, which [0001](./0001-closed-means-landed-on-integration.md) forbids.
The code would be on the integration branch while the planner kept deferring every dependent ticket
against a blocker it reads as open: a false deadlock.

**Retry the review once within the same round before giving up.** Considered and declined in favour
of fewer moving parts.

## Consequences

- A dead or skipped review agent (`agent()` returns `null`) now costs a round rather than being
  waved through. The cost is bounded: the branch is preserved and reused, and the implement stage is
  instructed to make no changes when the branch already satisfies the spec with a green suite, so
  the next round's retry is effectively just another review agent.
- A genuinely stuck issue now stalls its dependents and the run can end on `blocked`. This is
  intended: nothing has entered the integration branch, the issue is open, and the draft PR says
  why — an honest stop rather than a silent one.
- Because a failed review leaves an open issue with no trace on the tracker, the implement and
  review prompts are required to comment on the issue before returning `failed`, recording the
  reason and what already exists on `wf/issue-N`. The orchestrator cannot do this itself: the
  Workflow runtime exposes only `agent`/`pipeline`/`parallel`/`log`/`phase`/`args`/`budget`/
  `workflow` and has no filesystem or Node API, so there is no way to shell out to `gh` from the
  script body. Agents that die outright therefore leave no comment, and are covered only by the
  draft PR's unfinished list.
