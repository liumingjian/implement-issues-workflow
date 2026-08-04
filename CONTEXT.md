# implement-issues

A reusable Claude Code workflow that works through a backlog of tracker issues unattended,
re-planning every round and integrating onto a branch a human owns. This glossary fixes the terms
the workflow, its prompts, and its docs must all use in the same sense.

## Language

### Work items

**Spec**:
A parent issue whose tickets hang off it as sub-issues. Never built directly.
_Avoid_: umbrella, epic, parent

**Leaf ticket**:
An issue with no sub-issues — the only kind of work item the workflow builds. Distinguished from a
Spec by structure (`sub_issues_summary.total == 0`), never by a label.
_Avoid_: task, story, buildable issue

**Candidate**:
A leaf ticket that is open, carries the workflow's label, and has not been completed or set aside in
this run. Every candidate is either in the batch or deferred — exactly once.
_Avoid_: eligible issue, pending issue

**Batch**:
The candidates released to build in the current round.
_Avoid_: layer, wave, generation

**Deferred**:
A candidate held back this round because a blocking edge points at something not yet done. It
returns as a candidate next round.
_Avoid_: blocked, skipped, postponed

**Set aside**:
An issue withdrawn from the run after hitting the attempt cap. It stays open, keeps its branch
progress, and is reported for human attention. A set-aside issue is never a candidate again.
_Avoid_: abandoned, failed, parked

**Unfinished**:
Every open leaf ticket at the end of a run, whatever the reason — set aside, deferred, or never
reached. The list the draft PR hands back to the human.
_Avoid_: remaining, incomplete

### Dependencies

**Blocking edge**:
A reason one candidate must wait for another. Re-judged live each round, never persisted. Exactly
three kinds exist.
_Avoid_: dependency edge, DAG edge

**Logical**:
A blocking edge from a tracker `blocked_by` relationship whose blocker has been freshly verified as
open. Relationship membership alone is not a logical edge.
_Avoid_: hard dependency, real dependency

**File overlap**:
A blocking edge between candidates judged likely to edit the same files, so they are serialized
across rounds instead of colliding at merge.
_Avoid_: conflict risk, collision

**API shape**:
A blocking edge from a consumer to the producer of the interface it will be written against.
_Avoid_: contract dependency, interface dependency

### Branches and outcomes

**Integration branch**:
The branch a run creates off the base branch and merges every issue branch into. The workflow never
merges it into the base branch — a human owns that.
_Avoid_: staging branch, working branch, auto branch

**Issue branch**:
The per-issue branch `wf/issue-N`, built in its own worktree, reused and accumulated across rounds.
_Avoid_: feature branch, work branch

**Landed**:
Merged cleanly into the integration branch with the post-merge full suite green. Landed is *not*
shipped — the code has not reached the base branch until a human merges the draft PR.
_Avoid_: done, shipped, delivered, complete

**Closed**:
The tracker state the workflow sets when, and only when, an issue lands. It is read back as the
planner's "this dependency is satisfied" signal and carries no other meaning — never use issue state
to express quality, progress, or review outcome.
_Avoid_: finished, resolved

**Gate**:
A pass/fail check nothing advances past. The full test suite is a gate at three points (baseline,
per-ticket, post-merge); the review is a gate on the merge.
_Avoid_: check, validation, barrier

**Round**:
One pass of plan → build → review → merge. The planner answers "what is unblocked right now?" afresh
at the start of each one.
_Avoid_: iteration, cycle, layer
