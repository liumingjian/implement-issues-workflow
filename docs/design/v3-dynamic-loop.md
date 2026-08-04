# implement-issues v3 — dynamic re-plan loop (design decisions)

**Status:** implemented and hardened · **Date:** 2026-07-25

This document records the decisions implemented in `workflows/implement-issues.js`, including the
terminal-plan and dependency-state hardening added after a closed blocker was misread as open.

---

## 1. The problem

Two pain points from running v2:

1. **Planning mis-fires mid-run and derails the whole flow.** v2's `Plan` phase computes the
   *entire* topological DAG (all layers) in one LLM shot, then marches down it with no
   re-planning. A single wrong early layer poisons everything downstream, with no way back.
2. **Merge conflicts keep appearing after development.** v2's DAG only encodes *logical*
   dependencies (`blocked_by`). Two tickets that are logically independent but touch the same
   files land in the same layer, build in parallel worktrees, and collide at integration.

**Shared root cause.** Both trace to the same shape: v2 makes one big, brittle, up-front
commitment (the full DAG) and that DAG is blind to file overlap. Pain 1 is the commitment being
un-recoverable; pain 2 is the DAG missing the edge that predicts conflicts.

## 2. The core shift

Adopt the **sandcastle** design flow (`mattpocock/sandcastle`, template
`parallel-planner-with-review`): replace "compute the whole DAG once → static layered march"
with a **dynamic re-plan loop**.

- The planner never commits to a full DAG. Each round it answers only a small, local question:
  *of the currently-open issues, which have zero blockers right now?* — and releases just that
  batch. A mistake affects one round; the next re-plan self-corrects. (Fixes pain 1.)
- Conflict avoidance moves **forward, to plan time**: "these two tickets likely touch the same
  files" becomes a *blocking edge*, so file-overlapping tickets are serialized across rounds
  instead of run in parallel. (Fixes pain 2.)

We borrow sandcastle's **design flow**, not its **infrastructure**. Its Docker sandbox, Effect
service layer, and provider abstractions exist to ship a publishable TS library; we need a single
droppable Claude Code Workflow file. Those are out of scope (§6).

## 3. Locked decisions

| # | Area | Decision |
|---|------|----------|
| D0 | Deliverable | A single-file reusable workflow plus its decision and tracker documentation. |
| D1 | Planning architecture | Dynamic re-plan loop; each round releases only the currently-unblocked batch; **no static full DAG**. |
| D2 | Planner input | Explicit tracker `blocked_by` relationships identify logical deps, but relationship membership does **not** prove the blocker is open. The planner fetches each blocker's current issue state and defers only for verified-open blockers; issues completed in this run are authoritative across GitHub read lag. It additionally infers live *file-overlap* and *API-shape* edges. **No DAG file.** |
| D3 | Trust model | **Fully autonomous** planner — no human planning gate. Human oversight moves to hard test gates (during) + the draft PR (after). |
| D4 | Conflict avoidance | "File overlap" is a blocking criterion, judged by the planner each round (not persisted). |
| D5 | Residual conflict | Merge agent **resolves in place** by reading both sides. **Reuse the branch** and accumulate progress — never rebuild from scratch. Never halt the run. Keep the hard post-merge full-suite gate: red → roll back *that one* merge, return the issue to the next round. |
| D6 | Poison-ticket guard | Per-issue attempt cap **k = 2**. After 2 failures an issue is **set aside** — excluded from later rounds, left open for the final PR, its branch progress preserved. (sandcastle lacks this; v2's `RETRIES` instinct is kept.) |
| D7 | Isolation | **git worktree only.** Docker sandbox / Effect / providers = out of scope. |
| D8 | Model routing | Planner Opus/high · Implement Sonnet/med · Review Opus/med · Merge Opus/high · Preflight+gates Haiku/low. See §5. |
| D9 | Review structure | Separate **Opus** agent, same worktree/branch, **runs only if the implement stage produced commits**. (Forced by D8 — build and review use different models, so they cannot be one agent.) |
| D10 | Skill delegation | Stage prompts **delegate to existing skills** instead of re-describing them: Implement→`/tdd`, Review→`/code-review`, Merge→`/resolving-merge-conflicts`. `/implement` is **not** used wholesale because it bundles TDD+review under one model, which D8 forbids. See §4. |
| D11 | Prompt hosting | Prompts stay **inline** in the `.js` (preserves single-file install). Borrow only sandcastle's prompt **content**: the three blocking criteria, the review-checklist depth, the merge "resolve by reading both sides" wording, and "implement stage does not close the issue". |
| D12 | Kept from v2 | Baseline preflight gate (red base → abort) · leaf-ticket-only selection · integration branch + draft PR, **never touch base** · termination only after an independently confirmed `complete` or `blocked` frontier, `MAX_ITERATIONS` (default 10), low budget, or planner failure · Matt-Pocock tracker convention + `ready-for-agent` label. The v2 "layer barrier" **dissolves** — the per-merge full-suite gate already is the barrier. |

## 4. Stage → skill mapping (D10)

| Stage | Model | Skill invoked | Prompt reduces to |
|-------|-------|---------------|-------------------|
| Implement | Sonnet 5 | `/tdd` | claim #N, create worktree, run `/tdd` red→green on #N, commit to branch, **do not close** |
| Review | Opus 4.8 | `/code-review` | review this branch vs the integration tip (Standards + Spec), fix what it finds, commit |
| Merge / conflict | Opus 4.8 | `/resolving-merge-conflicts` | merge one branch, on conflict resolve via the skill, run full suite |

**Nesting caveat.** A workflow `agent()` is already a subagent; `/code-review` fans out its own
parallel sub-agents and may hit the one-level nesting cap. The Review stage is already its own
workflow agent, so if the inner fan-out can't spawn, it degrades to running the two axes
sequentially inside that one agent — same discipline/checklist, minus the parallelism. Not a
blocker, an implementation note.

## 5. Model routing (D8)

| Stage | Model | effort | Why |
|-------|-------|--------|-----|
| Planner | Opus 4.8 | high | Unsupervised single point of failure (D3) — top model is the hedge for dropping the human gate. |
| Implement | Sonnet 5 | medium | Day-to-day coding; the house default. |
| Review | Opus 4.8 | medium | Deeper checklist (security, edge cases, behavior-preservation). |
| Merge / conflict | Opus 4.8 | high | Semantic conflicts are fragile; last line before a bad merge — pain 2. |
| Preflight / gates | Haiku 4.5 | low | Mechanical: run the suite, report green. |

## 6. Target loop shape (the route)

**Preflight** (Haiku): read the tracker convention + coding standards; run the full suite on
`base` → red aborts (never build on a broken baseline); cut integration branch `auto/implement`
off `base`.

**Main loop** (round `r = 1..MAX_ITERATIONS`, while budget allows):

1. **Plan** (Opus/high): list open `ready-for-agent` issues → drop umbrella parents and set-aside
   issues; treat issues completed in this run as authoritative; discover `blocked_by` relationships
   and separately verify each blocker's current issue state; additionally infer *file-overlap* +
   *API-shape* edges. Emit all candidates as an exact `batch`/`deferred` partition with deterministic
   branch names `wf/issue-{id}`. A terminal or invalid plan is independently re-fetched once:
   no candidates → `complete`; all candidates waiting on verified-open logical blockers → `blocked`;
   a non-progressing overlap/API plan → `plan-invalid`.
2. **Fan-out** (per issue, in parallel; each in its own worktree off the integration tip; reuse
   the branch if it already exists):
   - **Implement** (Sonnet): claim → run `/tdd` red-green for #N → per-ticket full-suite gate →
     commit to the branch, **do not close**. Failure → `attempt++`.
   - **Review** (Opus, same worktree, only if commits exist): run `/code-review` (Standards +
     Spec) → fix → commit.
3. **Merge** (Opus/high, **serial**, one branch at a time onto the integration branch): merge →
   on conflict use `/resolving-merge-conflicts` → run the full suite after each → red rolls back
   *that one* merge and `attempt++` (issue returns to the next round); clean + green → **close
   the issue**.
4. **Set-aside update**: any issue reaching `attempt == 2` enters the set-aside set (excluded
   from later rounds).
5. Re-plan → next round.

**Finalize** (Haiku): reconcile all still-open buildable leaves—including deferred and
never-attempted issues—prune worktrees; push the integration branch; open a **draft PR** into
`base` summarizing what shipped and listing set-aside / unfinished issues. **Never merge into
`base`.**

## 7. Borrowed vs. not borrowed (sandcastle)

**Borrowed (content / flow):** the plan→fan-out→merge→re-plan loop; the three blocking criteria
(logical / file-overlap / API-shape); deterministic branch names for idempotent re-plan + branch
reuse; per-phase model split (Opus planner, Sonnet worker); review-only-if-commits; merge
"resolve by reading both sides"; implement-does-not-close.

**Not borrowed:** the `<promise>COMPLETE</promise>` completion signal + completion-timeout
(the Workflow harness already handles agent termination); `Output.object` schema validation
(we already have `agent(..., {schema})`); `{{KEY}}` substitution + `` !`cmd` `` shell expansion
(we build prompts in JS each round); Docker/Effect/providers; the `CONTEXT.md` glossary and
`.out-of-scope/` doc discipline (good habits, out of scope here).

## 8. Out of scope

Docker sandbox / Effect / provider abstraction · a persisted DAG file (the original "compute
once → file" proposal, retired by D2) · `/acceptance-gate` inside the loop (the per-merge full
suite suffices; at most an optional pre-PR gate) · ~~sandcastle's glossary~~ / `.out-of-scope/`
documentation discipline.

> **Superseded (2026-08-04):** the glossary exclusion was wrong. "Closed" turned out to be carrying
> two incompatible meanings — "this dependency is satisfied" and "this shipped" — which cost a full
> design session to untangle. See [`CONTEXT.md`](../../CONTEXT.md) and
> [v4-close-semantics.md](./v4-close-semantics.md).
