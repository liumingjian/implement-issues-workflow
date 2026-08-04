# implement-issues v4 — issue close semantics (remediation plan)

**Status:** implemented · **Date:** 2026-08-04

Follows on from [v3-dynamic-loop.md](./v3-dynamic-loop.md). It answers one question that v3 left
implicit: **when, exactly, is an issue closed, and what happens to the ones that are not?**

Decisions: [ADR 0001](../adr/0001-closed-means-landed-on-integration.md),
[ADR 0002](../adr/0002-review-failure-blocks-merge.md).

---

## 1. The governing rule

> `open` / `closed` is the planner's **dependency signal** and carries no other meaning.
> Quality, progress and failure information travels as **issue comments and PR body text**.

Everything below is a consequence of holding that line. v3 already used issue state this way
(D2: blockers are re-verified live each round) but never wrote down what that costs.

## 2. Decisions

| # | Decision | Where it lands |
|---|----------|----------------|
| D1 | An issue is closed when its branch merges cleanly into the integration branch **and** the post-merge full suite is green. Implement and review never close. | already true — no change |
| D2 | The "re-running before merging the previous draft PR drops closed issues' code" gap is a **documented human precondition**, not a preflight branch-resume feature. | README + finalize prompt |
| D3 | The close comment must name the **integration branch** and the **merge commit sha**, so an abandoned draft PR's closures are findable and reopenable. No new labels. | merge prompt |
| D4 | A review that does not return `success` **blocks the merge**: `bump()`, issue stays open, retried next round, set aside at `k = 2`. | orchestration |
| D5 | Whenever an issue is left open by a failure, the failing **agent** comments on it — reason plus what already exists on `wf/issue-N`. Assignee is left in place. | implement + review prompts |

### Why D5 lives in the prompts

The Workflow runtime's script body has only `agent`, `pipeline`, `parallel`, `log`, `phase`,
`args`, `budget`, `workflow` — and explicitly **no filesystem or Node.js API access**. `bump()` is
plain synchronous JS, so it cannot shell out to `gh`. Writing the comment must therefore be an
instruction inside the agent prompts. The uncoverable gap: an agent that dies or is skipped returns
`null` and writes nothing, so those issues are visible only in the draft PR's unfinished list.

## 3. Code deltas

All in `workflows/implement-issues.js` unless noted. Line numbers are against the current tip.

### 3.1 D3 — close comment format (`mergePrompt`, step 5, ~`:292`)

Replace "Post a resolution comment on #N summarising what shipped" with a required first line:

```
Landed on `<integration-branch>` as <merge-commit-sha>.
```

followed by the summary, and close the issue with that same body. The branch name is what makes
`gh issue list --state closed --search "<integration-branch>"` work.

### 3.2 D4 — review failure blocks merge (orchestration, ~`:414`)

```js
// before
if (b.reviewOk === false) log(`#${t.number} review incomplete — merging the gated build anyway`)

// after
if (!b.reviewOk) {
  bump(t.number, 'review did not pass')
  log(`#${t.number} review failed — not merging (${attempts.get(t.number)}/${MAX_ATTEMPTS})` +
      `${setAside.has(t.number) ? ' — set aside' : ''}`)
  continue
}
```

Keep the two `bump()` reason strings distinct — `'build failed'` vs `'review did not pass'` — so the
set-aside reason that reaches `unfinished` and the PR body says which gate stopped it.

### 3.3 D5 — failure-path comments

**`implementPrompt`, failure paragraph (~`:253`).** Before returning `status: "failed"`, run
`gh issue comment` on the issue stating: which attempt this was, why it failed, and precisely what
already exists on `wf/issue-N` (commits, passing/failing tests). Then return.

**`reviewPrompt` (~`:258-274`) has no failure path at all** — it only describes the happy flow. Add
one: if the review cannot be completed, or a finding cannot be fixed while keeping the full suite
green, comment on the issue the same way and return `status: "failed"`. Say explicitly that the
build **will not be merged** in that case, so the agent does not assume its work is about to land.

### 3.4 D2 — re-run precondition

**`finalizePrompt`, PR body instructions (~`:317`).** The body must state that this branch has to be
merged (or explicitly discarded and its issues reopened) **before the workflow is run again** —
otherwise the next run cuts a fresh integration branch off base without this branch's commits, while
the issues it closed are no longer eligible for re-release.

**`README.md`.** Add the same as a prerequisite, and update three places that D4 makes stale:
Pipeline §2 "Build (parallel)" and "Merge (serial)" bullets (review is now a gate, not advisory),
the Safety section (a build can now be discarded for review reasons), and Design decisions
("Test gate is absolute" should read as two gates: the suite *and* the review).

## 4. Explicitly rejected

- **Preflight resuming the newest `auto/implement*` branch** (instead of D2's documented
  precondition) — it can silently continue on a branch you meant to discard.
- **A `landed-on-integration` label** (instead of D3's comment format) — breaks the project's
  "no new labelling discipline" promise.
- **Merging an unreviewed-but-green build with a "review incomplete" note** — see ADR 0002.
- **Leaving the issue open while merging its code anyway** — makes issue state lie to the planner;
  a false deadlock.
- **A same-round review retry before falling through to D4** — declined for fewer moving parts.

## 5. Verification

1. `bump()` on review failure → verify: a run where the review agent fails shows the issue open,
   `wf/issue-N` unmerged, and the integration branch unchanged.
2. Set-aside reason distinguishes build vs review → verify: PR body's unfinished list names the gate.
3. Close comment format → verify: `gh issue list --state closed --search "<integration-branch>"`
   returns exactly the issues that run closed.
4. Failure comment present → verify: a failed issue has a comment naming `wf/issue-N` and the reason.
