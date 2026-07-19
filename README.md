# implement-issues — unattended DAG-parallel implementation workflow for Claude Code

A **reusable Claude Code workflow** that works through a whole backlog of issues without
babysitting. It builds the ticket **dependency DAG**, auto-reviews the plan, then implements each
**topological layer in parallel** (isolated git worktrees) behind **hard test gates** — landing
everything on an integration branch with a draft PR for you to review. It never touches your
base branch.

It is a *development framework*, not tied to any specific issue, and it makes **zero changes to
your skills** — it works on top of the artifacts that `/to-spec` and `/to-tickets` produce.

## Pipeline

1. **Preflight** — reads your tracker convention, runs a **baseline test gate** on the current
   branch (aborts if red — never build on a broken baseline), and cuts a fresh integration
   branch `auto/implement`.
2. **Plan** — lists open `ready-for-agent` issues and **selects only leaf tickets**. Both
   `/to-spec` specs and `/to-tickets` tickets carry the same label, so the label alone is not
   enough: an umbrella/spec is a *parent* issue (`sub_issues_summary.total > 0`), a buildable
   ticket is a *leaf* (`total == 0`). Specs are excluded. Blockers (`blocked_by`) become DAG
   edges, and the DAG is sliced into **topological layers** — each layer is a set of mutually
   independent tickets safe to build in parallel.
3. **Review** — a plan reviewer with **abort power** vets the DAG. Structural problems (cycles,
   a spec that slipped in, mis-layering) it fixes automatically; a **major directional doubt**
   aborts the run rather than bulk-writing wrong code.
4. **Execute** — for each layer, in order:
   - **parallel build**: one agent per ticket in its **own git worktree**, running the
     `/implement` discipline (claim → TDD red-green → per-ticket test gate → two-axis code
     review) and committing to a ticket branch. Nothing merges yet.
   - **serial integration**: merge each ticket branch into the integration branch and re-run the
     **full suite** (post-merge gate). A git **or semantic** conflict (clean merge, red tests) →
     the ticket is **rebuilt against the updated tip** and re-integrated (optimistic parallelism
     with serial fallback), up to `retries` times.
   - **layer barrier**: full suite must be green before the next layer starts.
   - Any unresolved failure **halts the layer** and leaves the issue open for a human.
5. **Finalize** — push the integration branch and open a **draft PR** into your base branch.
   **Never auto-merges** — you own the final gate.

## Design decisions

- **Fully unattended** — no human gate mid-run; the plan reviewer is the safeguard, the draft PR
  is the after-the-fact review surface.
- **Robustness over speed/cost** — worktree isolation (each may install its own deps), a full
  test run at every gate, and conflict-driven rebuilds. It deliberately spends more to stay
  correct.
- **Test gate is absolute** — nothing advances on a red suite: baseline, per-ticket, post-merge,
  and layer barrier.
- **Spec vs ticket by structure, not labels** — so it needs no new labelling discipline and no
  changes to the Matt-Pocock skills.

## Safety

- Never fakes a green suite or a passing review; a stuck ticket is left **open** with an
  explanation, and its layer halts.
- Aborts before writing any code if the **baseline is red** or the **plan reviewer** has a major
  doubt.
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
    retries: 1,               // optional — conflict rebuilds per ticket
    push: true                // optional — false = keep integration branch local, no PR
  }
})
```

## Returns

```js
{ integrationBranch, baseBranch, completed: [numbers], failed: [{number, summary}],
  halted: boolean, pr: url|null, pushed: boolean }
```

## Notes

- Mind the token budget — worktree-parallel builds with full test runs at every gate are
  heavier than a naive sequential loop. The workflow winds down when the budget runs low.
- Concurrency is capped automatically by the workflow engine (~min(16, cores-2)).

---

Generated with [Claude Code](https://claude.com/claude-code).
