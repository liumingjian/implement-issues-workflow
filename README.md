# implement-issues — unattended implementation workflow for Claude Code

A **reusable Claude Code workflow** that works through a whole backlog of issues without
babysitting. It discovers agent-ready tickets, respects their blocking edges, and builds each
one in a **fresh context** via TDD + a two-axis code review — then commits and closes it — and
loops until the frontier is dry.

It is a *development framework*, not tied to any specific issue or repo. It adapts to your
project by reading your tracker convention at runtime.

## What it does, each round

1. **Scan** — a read-only agent reads your `docs/agents/issue-tracker.md`, lists open issues
   labelled `ready-for-agent`, queries each one's GitHub native `blocked_by` dependencies, and
   picks the single lowest-numbered ticket whose blockers are **all closed** (blockers-first).
2. **Implement** — a fresh-context agent owns that one ticket end-to-end, following the
   `/implement` discipline:
   - claim it (`--add-assignee @me`), read the spec + thread,
   - build **test-first** (red → green, slice by slice),
   - run the full suite,
   - **code-review the diff on two axes** — *Standards* (your repo's coding standards) and
     *Spec* (does the diff deliver what the issue asked?),
   - commit referencing the issue, post a resolution comment, close it.
3. **Loop** — re-scan (a just-closed ticket may unblock downstream work) until nothing is
   eligible.

## Safety

- Never fakes a green suite or a passing review. If it gets genuinely stuck, it sets the ticket
  `failed`, **leaves the issue open**, and explains why for a human.
- Halts after **2 consecutive failures** for human review.
- Winds down when the token budget runs low.
- Never retries a ticket it already attempted this run (no infinite loops).
- `dryRun` mode plans and builds but never commits or closes.

## Prerequisites

- **Claude Code** with the Workflow capability.
- **`gh` CLI**, authenticated (`gh auth login`), with `repo` scope.
- Your repo follows the **Matt-Pocock issue-tracker convention**:
  - a `docs/agents/issue-tracker.md` describing your tracker ops (see
    [`docs/issue-tracker.example.md`](docs/issue-tracker.example.md)),
  - implementation-ready issues carry the **`ready-for-agent`** label,
  - dependencies are expressed as **GitHub native issue dependencies** (`blocked_by`).

## Install

Drop the script into your Claude Code workflows directory:

```bash
# global (all projects)
cp workflows/implement-issues.js ~/.claude/workflows/

# or per-project
mkdir -p .claude/workflows && cp workflows/implement-issues.js .claude/workflows/
```

## Use

From Claude Code, ask it to run the workflow, or invoke directly:

```js
Workflow({
  scriptPath: "~/.claude/workflows/implement-issues.js",
  args: {
    repo: "owner/name",   // optional — inferred from git origin if omitted
    label: "ready-for-agent", // optional — the "buildable" label
    max: 5,               // optional — cap tickets built this run
    dryRun: false         // optional — true = plan/build but don't commit or close
  }
})
```

**Recommendation:** run with `dryRun: true` first to see which tickets it would pick and in
what order, then run for real.

## Returns

```js
{ built, succeeded: [numbers], failed: [{number, summary}], results: [...] }
```

## Notes

- Tune `max` and mind the token budget — real tickets are heavier than toy ones.
- The workflow is deliberately **sequential** (one ticket at a time) to keep shared-file edits
  conflict-free and each build in a clean context.

---

Generated with [Claude Code](https://claude.com/claude-code).
