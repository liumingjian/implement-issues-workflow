# implement-issues — unattended dynamic-replan implementation workflow for Claude Code

A **reusable Claude Code workflow** that works through a whole backlog of issues without
babysitting. Instead of committing to one big up-front dependency graph, it runs a **dynamic
re-plan loop**: every round it releases only the issues that are safe to build **right now**,
builds them in parallel (isolated git worktrees, TDD), reviews them, then serially merges each
behind a **hard full-suite gate** — landing everything on an integration branch with a draft PR
for you to review. It never touches your base branch.

It is a *development framework*, not tied to any specific issue, and it makes **zero changes to
your skills** — it works on top of the artifacts that `/to-spec` and `/to-tickets` produce, and
delegates each stage to an existing skill (`/tdd`, `/code-review`, `/resolving-merge-conflicts`).

## Pipeline

1. **Preflight** — reads your tracker convention, runs a **baseline test gate** on the current
   branch (aborts if red — never build on a broken baseline), and cuts a fresh integration
   branch `auto/implement`.
2. **Re-plan loop** — each round (up to `maxRounds`, while budget allows):
   - **Plan** — lists open `ready-for-agent` issues and **selects only leaf tickets**. Both
     `/to-spec` specs and `/to-tickets` tickets carry the same label, so the label alone is not
     enough: an umbrella/spec is a *parent* issue (`sub_issues_summary.total > 0`), a buildable
     ticket is a *leaf* (`total == 0`). Specs are excluded. The planner then releases **only the
     currently-unblocked batch**, treating three things as blocking edges it re-judges live:
     **logical** deps (`blocked_by` relationship members whose issue state is freshly verified as
     `OPEN`), **file overlap** (two issues likely editing the same files are *serialized* across
     rounds instead of colliding at merge), and **API shape** (a consumer waits for its producer).
     A dependency relationship alone does not prove that its blocker is open, and issues completed
     in the current run are authoritative even if GitHub reads lag. It never commits to a full DAG.
     A terminal plan is independently confirmed: no candidates means **complete**; candidates all
     waiting on verified-open logical blockers means **blocked**.
   - **Build (parallel)** — one agent per released issue in its **own git worktree** on a
     deterministic branch `wf/issue-{n}` (reused and accumulated across rounds, never rebuilt):
     claim → `/tdd` red-green → per-ticket full-suite gate → commit. Then, **only if commits
     landed**, a separate reviewer agent runs `/code-review` (Standards + Spec) and commits fixes.
     **The review is a gate**: if it doesn't pass, the branch is not merged and the issue returns to
     a later round — a green suite alone is not enough to land.
   - **Merge (serial)** — merge each built-and-reviewed branch into the integration branch one at a
     time; a conflict is **resolved in place** via `/resolving-merge-conflicts` (read both sides,
     never rebuild). The **full suite runs after every merge** — this per-merge gate *is* the
     barrier. Green + clean → the issue is **closed**, with a comment naming the integration branch
     and merge sha. Red → that one merge is **rolled back** and the issue returns to a later round.
   - **Set-aside** — an issue that fails (build or merge) twice (**k=2**) is parked: excluded from
     later rounds, left **open** for the PR, its branch progress preserved.
3. **Finalize** — reconcile every still-open buildable leaf (including deferred or never-attempted
   tickets), push the integration branch, and open a **draft PR** into your base branch, summarising
   what landed and listing every set-aside / unfinished issue. **Never auto-merges** — you own the
   final gate.

## Design decisions

- **Dynamic re-plan over a static DAG** — the planner answers one small, local question each round
  ("what's unblocked *now*?") rather than pre-computing every layer. This is what makes a bad early
  plan recoverable and lets file-overlap avoidance move forward into planning.
- **Fully unattended** — no human planning gate; oversight is the **hard test gates** during the
  run and the **draft PR** after it.
- **Per-stage model routing** — planner Opus/high (unsupervised single point of failure), implement
  Sonnet/med (house default), review Opus/med, merge Opus/high (fragile semantic conflicts),
  preflight & gates Haiku/low (mechanical).
- **Robustness over speed/cost** — worktree isolation (each may install its own deps) and a full
  test run at every gate. It deliberately spends more to stay correct.
- **Gates are absolute** — nothing advances on a red suite (baseline, per-ticket, every post-merge
  run), and nothing merges without a passing review. Skipping review on a green build would let a
  wrong-but-tested interface become the foundation the next round's consumers are written against
  ([ADR 0002](docs/adr/0002-review-failure-blocks-merge.md)).
- **`closed` means landed, not shipped** — an issue is closed the moment it lands on the integration
  branch, because issue state is the planner's only dependency signal. Quality and progress
  information travels as comments, never as issue state
  ([ADR 0001](docs/adr/0001-closed-means-landed-on-integration.md), [`CONTEXT.md`](CONTEXT.md)).
- **Spec vs ticket by structure, not labels** — so it needs no new labelling discipline and no
  changes to the Matt-Pocock skills.

## Safety

- Never fakes a green suite or a passing review; a stuck issue is left **open**, with the failing
  agent commenting on the issue itself (why it failed, what already exists on `wf/issue-N`), and the
  run keeps going on the rest of the backlog. A build whose review fails is discarded rather than
  merged, even though its suite is green.
- Aborts before writing any code if the **baseline is red**. A merge that breaks the suite is
  **rolled back** — a red suite never lands.
- **Subagents write to your tracker** (assign, comment, close issues; push a branch; open a PR).
  Only run it against a repo where that is acceptable — launching the workflow is your
  authorization for those writes.

## Prerequisites

- **Claude Code** with the Workflow capability.
- **`gh` CLI**, authenticated (`gh auth login`), with `repo` scope.
- Your repo follows the **Matt-Pocock issue-tracker convention**:
  - a `docs/agents/issue-tracker.md` (see [`docs/issue-tracker.example.md`](docs/issue-tracker.example.md)),
  - implementation-ready tickets carry the **`ready-for-agent`** label,
  - dependencies use **GitHub native issue dependencies** (`blocked_by`),
  - specs are **parent issues** with their tickets attached as **sub-issues**.
- A project with a runnable test command (the agents detect it).
- **Before re-running: merge or discard the previous run's draft PR.** Each run cuts a fresh
  integration branch off the base, and the planner only releases *open* issues — so if a previous
  run's branch is still unmerged, the work behind its already-closed issues is neither in the new
  branch nor eligible to be rebuilt. To discard instead, reopen its issues first:
  `gh issue list --state closed --search "auto/implement"`.

## Install

```bash
# global (all projects)
cp workflows/implement-issues.js ~/.claude/workflows/

# or per-project
mkdir -p .claude/workflows && cp workflows/implement-issues.js .claude/workflows/
```

## Use

```js
Workflow({
  scriptPath: "~/.claude/workflows/implement-issues.js",
  args: {
    repo: "owner/name",       // optional — inferred from git origin if omitted
    label: "ready-for-agent", // optional — the "buildable" label
    maxRounds: 10,            // optional — outer re-plan loop cap (termination)
    maxAttempts: 2,           // optional — per-issue failures before an issue is set aside (k)
    push: true                // optional — false = keep integration branch local, no PR
  }
})
```

## Returns

```js
{ integrationBranch, baseBranch,
  completed: [numbers],                     // landed on the integration branch and closed
  unfinished: [{number, reason}],           // all open buildable leaves: set-aside, deferred, failed, or not reached
  setAside: [{number, reason}],             // hit the attempt cap
  rounds: number, stoppedBy: string,        // "complete" | "blocked" | "max-rounds" | "budget" |
                                             // "plan-failed" | "plan-invalid"
  pr: url|null, pushed: boolean }
```

## Notes

- Mind the token budget — worktree-parallel builds with full test runs at every gate are
  heavier than a naive sequential loop. The workflow winds down when the budget runs low.
- Concurrency is capped automatically by the workflow engine (~min(16, cores-2)).

---

Generated with [Claude Code](https://claude.com/claude-code).
