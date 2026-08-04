export const meta = {
  name: 'implement-issues',
  description: 'Unattended dynamic re-plan loop: each round the planner releases only the currently-unblocked batch of leaf tickets (logical + file-overlap + API-shape blocking), builds them in parallel worktrees (TDD), reviews, then serially merges behind a hard full-suite gate — integrating onto a branch for human review',
  whenToUse: 'Run the /implement discipline over a whole backlog without babysitting. Instead of committing to one big up-front DAG, it re-plans every round and only releases issues that are safe to build right now, so a planning mistake self-corrects and file-overlapping tickets get serialized instead of colliding at merge. Works against any repo following the Matt-Pocock issue-tracker convention (docs/agents/issue-tracker.md). Zero changes to the Matt skills.',
  // Stage → model per §5 (effort per stage lives in the `M` table below — the routing source of truth).
  phases: [
    { title: 'Preflight', detail: 'baseline test gate + create integration branch', model: 'haiku' },
    { title: 'Plan', detail: 'release the currently-unblocked batch (re-planned each round)', model: 'opus' },
    { title: 'Implement', detail: 'per issue, parallel worktree: /tdd build behind the per-ticket suite gate', model: 'sonnet' },
    { title: 'Review', detail: 'per issue: /code-review (Standards + Spec), only if the build committed', model: 'opus' },
    { title: 'Merge', detail: 'serial merge behind the full-suite gate; resolve conflicts in place', model: 'opus' },
    { title: 'Finalize', detail: 'push integration branch + open draft PR', model: 'haiku' },
  ],
}

// ---- Config (all optional, via args) ---------------------------------------
const REPO         = args?.repo        ?? null
const LABEL        = args?.label       ?? 'ready-for-agent'
const PUSH         = args?.push        ?? true   // push integration branch + open draft PR
const MAX_ROUNDS   = args?.maxRounds   ?? 10     // outer re-plan loop cap (termination)
const MAX_ATTEMPTS = args?.maxAttempts ?? 2      // per-issue failures before set-aside (D6, k=2)
const repoFlag = REPO ? `--repo ${REPO}` : ''
const repoNote = REPO ? `Repository: ${REPO}.` : 'Infer the repo from the current git origin.'

// Deterministic branch/worktree names → idempotent re-plan + branch reuse (D5, §6).
const branchOf   = (n) => `wf/issue-${n}`
const worktreeOf = (n) => `../wf-worktrees/issue-${n}`

// Model routing (D8/§5). Short aliases map to the current tiers:
//   opus → Opus 4.8 · sonnet → Sonnet 5 · haiku → Haiku 4.5
const M = {
  plan:      { model: 'opus',   effort: 'high'   }, // unsupervised single point of failure — top model hedges the dropped human gate
  implement: { model: 'sonnet', effort: 'medium' }, // day-to-day coding, the house default
  review:    { model: 'opus',   effort: 'medium' }, // deeper checklist: security, edge cases, behaviour-preservation
  merge:     { model: 'opus',   effort: 'high'   }, // semantic conflicts are fragile — last line before a bad merge
  gate:      { model: 'haiku',  effort: 'low'    }, // mechanical: run the suite, report green
}

// ---- Schemas ---------------------------------------------------------------
const PREFLIGHT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    baseGreen: { type: 'boolean' },
    baseBranch: { type: 'string' },
    integrationBranch: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['baseGreen', 'baseBranch', 'integrationBranch', 'summary'],
}

const TICKET = {
  type: 'object', additionalProperties: false,
  properties: { number: { type: 'integer' }, title: { type: 'string' } },
  required: ['number', 'title'],
}

const REASONED = {
  type: 'object', additionalProperties: false,
  properties: { number: { type: 'integer' }, reason: { type: 'string' } },
  required: ['number', 'reason'],
}

const DEFERRED = {
  type: 'object', additionalProperties: false,
  properties: {
    number: { type: 'integer' },
    title: { type: 'string' },
    kind: { type: 'string', enum: ['logical', 'file-overlap', 'api-shape'] },
    blockedBy: { type: 'array', items: { type: 'integer' } },
    reason: { type: 'string' },
  },
  required: ['number', 'title', 'kind', 'blockedBy', 'reason'],
}

// The planner accounts for every current candidate, then releases only the safe batch.
const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    candidates: { type: 'array', items: TICKET },
    batch:      { type: 'array', items: TICKET },
    deferred:   { type: 'array', items: DEFERRED },
    excluded:   { type: 'array', items: REASONED },
    summary:    { type: 'string' },
  },
  required: ['candidates', 'batch', 'deferred', 'excluded', 'summary'],
}

const IMPLEMENT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    number: { type: 'integer' },
    status: { type: 'string', enum: ['success', 'failed'] },
    committed: { type: 'boolean' },   // did any work land on the branch?
    testsPassed: { type: 'boolean' }, // per-ticket full-suite gate inside the worktree
    summary: { type: 'string' },
  },
  required: ['number', 'status', 'committed', 'testsPassed', 'summary'],
}

const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    number: { type: 'integer' },
    status: { type: 'string', enum: ['success', 'failed'] },
    changed: { type: 'boolean' },   // did the review commit fixes?
    summary: { type: 'string' },
  },
  required: ['number', 'status', 'changed', 'summary'],
}

const MERGE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    number: { type: 'integer' },
    result: { type: 'string', enum: ['clean', 'failed'] }, // failed = unresolved conflict OR post-merge red (rolled back)
    testsPassed: { type: 'boolean' },
    issueClosed: { type: 'boolean' },
    commit: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['number', 'result', 'testsPassed', 'issueClosed', 'summary'],
}

const FINALIZE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    pushed: { type: 'boolean' },
    prUrl: { type: 'string' },
    unfinished: { type: 'array', items: REASONED },
    summary: { type: 'string' },
  },
  required: ['pushed', 'unfinished', 'summary'],
}

const classifyPlan = (plan, done, setAside) => {
  const candidateNumbers = plan.candidates.map(t => t.number)
  const batchNumbers = plan.batch.map(t => t.number)
  const deferredNumbers = plan.deferred.map(t => t.number)
  const unique = (numbers) => new Set(numbers).size === numbers.length
  const ascending = (numbers) => numbers.every((n, i) => i === 0 || numbers[i - 1] < n)
  const candidateSet = new Set(candidateNumbers)
  const partition = [...batchNumbers, ...deferredNumbers]

  if (!unique(candidateNumbers) || !unique(batchNumbers) || !unique(deferredNumbers)) {
    return { kind: 'invalid', reason: 'duplicate issue number in plan' }
  }
  if (!ascending(candidateNumbers) || !ascending(batchNumbers)) {
    return { kind: 'invalid', reason: 'candidates and batch must be strictly ascending' }
  }
  if (partition.some(n => !candidateSet.has(n)) || new Set(partition).size !== partition.length ||
      partition.length !== candidateNumbers.length) {
    return { kind: 'invalid', reason: 'batch and deferred must exactly partition candidates' }
  }
  if (candidateNumbers.some(n => done.includes(n) || setAside.includes(n))) {
    return { kind: 'invalid', reason: 'completed or set-aside issue appeared as a candidate' }
  }
  if (plan.deferred.some(d => !d.blockedBy.length)) {
    return { kind: 'invalid', reason: 'deferred issue has no blocker evidence' }
  }
  if (!candidateNumbers.length) return { kind: 'complete' }
  if (batchNumbers.length) return { kind: 'ready' }
  if (plan.deferred.every(d => d.kind === 'logical')) return { kind: 'blocked' }
  return { kind: 'invalid', reason: 'overlap/API-shape deferral released no issue' }
}

// ---- Prompts (inline; delegate to skills per D10) --------------------------
const preflightPrompt = `
You are the PREFLIGHT gate for an unattended implementation run. ${repoNote}
Do NOT implement anything.

1. Read docs/agents/issue-tracker.md and the repo's coding-standards doc (e.g. CLAUDE.md/README).
2. Determine the current branch — that is the BASE branch. Report it as baseBranch.
3. HARD BASELINE GATE: run the project's full test suite on the base branch (detect the command
   from package.json/Makefile/etc). If the repo has genuinely no test setup, treat baseGreen as
   true and say so. If tests exist and are RED, set baseGreen=false and STOP (do not create
   anything) — we never build on a broken baseline.
4. If green: create a fresh integration branch off the base named "auto/implement". If that name
   already exists, append -2, -3, ... until unique. Leave it checked out. Report its name as
   integrationBranch.
Return ONLY the structured object.
`

const planPrompt = (round, setAside, done, mode = 'normal') => `
You are the PLANNER for round ${round} of an unattended implementation loop (${mode} pass). ${repoNote}
Do NOT write code. You do NOT commit to a full DAG — each round you release ONLY the issues that
are safe to build in parallel RIGHT NOW.

Workflow-owned facts for this run:
- Completed and closed: ${done.length ? done.map(n => '#' + n).join(', ') : 'none'}.
- Set aside after the attempt cap: ${setAside.length ? setAside.map(n => '#' + n).join(', ') : 'none'}.
These facts are authoritative for this run. Remove completed and set-aside issues from candidates.
A completed issue is also a satisfied dependency even if a GitHub read temporarily lags.

1. Read docs/agents/issue-tracker.md for tracker conventions.
2. Freshly list OPEN issues carrying the "${LABEL}" label:
   gh issue list ${repoFlag} --state open --label "${LABEL}" --json number,title
3. LEAF-ONLY. For each listed issue, fetch '.sub_issues_summary.total'. Keep only concrete,
   buildable leaves. Put every umbrella/spec in "excluded" with a reason.
4. Emit "candidates" = EVERY remaining open, labelled, buildable leaf after removing the
   workflow-owned completed and set-aside numbers. Sort it by ascending number.
5. Partition every candidate EXACTLY ONCE into "batch" or "deferred":
   a. LOGICAL dependency:
      - First discover relationship members:
          gh api repos/<owner>/<name>/issues/<number>/dependencies/blocked_by --jq '.[].number'
      - Relationship membership does NOT prove a blocker is open. For every returned blocker not
        in the completed list, fetch its current lifecycle state:
          gh issue view <blocker-number> ${repoFlag} --json number,state --jq '{number,state}'
      - Defer only for blockers whose freshly fetched state is OPEN. CLOSED blockers are satisfied.
        Never infer openness merely because the dependency endpoint returned an issue number.
      - Use kind="logical" and blockedBy=[verified open blocker numbers].
   b. FILE OVERLAP: serialize candidates likely to edit the same files. Release one now; defer the
      rest with kind="file-overlap" and blockedBy=[released candidate number(s)].
   c. API SHAPE: release the producer; defer consumers with kind="api-shape" and
      blockedBy=[producer candidate number(s)].
   Every deferred item must include number, title, kind, non-empty blockedBy, and a precise reason.
   Never defer an entire file-overlap/API-shape group: release at least one member so progress occurs.
6. Emit "batch" in ascending issue-number order. batch + deferred must be an exact, disjoint
   partition of candidates. An empty batch is only a proposed terminal observation; orchestration
   will independently confirm it with another fresh pass.
${mode === 'confirmation' ? `
This is a CONFIRMATION pass because the prior result was terminal or invalid. Do not reuse its
factual conclusions. Re-run all issue, leaf, relationship, and blocker-state queries from GitHub.
` : ''}
Return ONLY the structured object.
`

const implementPrompt = (t, integ) => `
You implement EXACTLY ONE issue TEST-FIRST in an ISOLATED git worktree. Never touch the main
working tree or the integration branch directly. ${repoNote}

Issue #${t.number} — "${t.title}". Integration branch: ${integ}. Branch: ${branchOf(t.number)}.

0. Read docs/agents/issue-tracker.md and the coding-standards doc (CLAUDE.md).
1. Claim it: gh issue edit ${t.number} ${repoFlag} --add-assignee @me
2. Read it fully: gh issue view ${t.number} ${repoFlag} --comments
3. Set up the worktree, REUSING branch ${branchOf(t.number)} if it already exists — accumulate
   progress across rounds, NEVER rebuild from scratch:
     root=$(git rev-parse --show-toplevel)
     wt="$root/${worktreeOf(t.number)}"
     if git show-ref --verify --quiet refs/heads/${branchOf(t.number)}; then
       git worktree add "$wt" ${branchOf(t.number)} 2>/dev/null || true   # reuse existing branch
     else
       git worktree add -B ${branchOf(t.number)} "$wt" ${integ}            # fresh off the current tip
     fi
   Do ALL work inside "$wt". Install dependencies there if the project needs them (e.g. npm install).
4. Drive the implementation with the /tdd skill: red → green, slice by slice, until the issue's
   spec is satisfied. Keep changes surgical — only what this issue asks for. If the branch already
   satisfies the spec with a green suite (a merge-retry round), make no changes.
5. GATE (per-ticket): run the FULL test suite inside the worktree; it must be 100% green.
6. Commit to branch ${branchOf(t.number)} with a message referencing #${t.number}. Do NOT merge,
   do NOT push, do NOT CLOSE the issue — integration is a separate stage.

If you cannot make the suite green or the spec is ambiguous, STOP and leave the issue OPEN. Before
returning, record the state on the tracker so the next person or round can pick it up:
  gh issue comment ${t.number} ${repoFlag} --body "..."
The comment must say why the attempt failed and exactly what already exists on ${branchOf(t.number)}
(commits made, which tests pass and which fail). Then return status "failed".
NEVER fake a green suite. Report committed=true only if work is on the branch.
Return ONLY the structured object.
`

const reviewPrompt = (t, integ) => `
You REVIEW one freshly-implemented issue branch and FIX what you find. ${repoNote}
Issue #${t.number} — "${t.title}". Branch: ${branchOf(t.number)} (already committed, suite green).
Work inside its worktree: "$(git rev-parse --show-toplevel)/${worktreeOf(t.number)}".

Review this branch's diff versus the integration tip (${integ}) using the /code-review skill on
BOTH axes:
  - Standards — does it follow this repo's documented coding standards?
  - Spec — does it deliver EXACTLY what #${t.number} asked, no more and no less?
NESTING NOTE: you are already a subagent. If /code-review cannot fan out its own parallel
sub-agents (one-level nesting cap), run the two axes sequentially yourself with the same checklist
depth — same discipline, minus the parallelism.

Fix every real issue you find, re-run the FULL suite (it must STAY green), and commit the fixes to
the same branch (${branchOf(t.number)}). Do NOT merge, push, or close.

REVIEW IS A GATE. If you cannot complete the review, or you find something you cannot fix while
keeping the full suite green, this branch WILL NOT BE MERGED — do not assume your work is about to
land. Leave the issue OPEN and record the state on the tracker before returning:
  gh issue comment ${t.number} ${repoFlag} --body "..."
The comment must say what the review found or why it could not finish, and what exists on
${branchOf(t.number)} right now. Then return status "failed".
Return ONLY the structured object (changed=true only if you committed fixes).
`

const mergePrompt = (t, integ) => `
You MERGE one built-and-reviewed branch into the integration branch and verify it. Work in the
MAIN working tree. ${repoNote}

Issue #${t.number}. Source branch: ${branchOf(t.number)}. Integration branch: ${integ}.

1. git checkout ${integ}
2. git merge --no-ff ${branchOf(t.number)} -m "Integrate #${t.number}"
3. If git reports CONFLICTS: resolve them IN PLACE using the /resolving-merge-conflicts skill —
   read BOTH sides and reconcile the intent. NEVER rebuild the branch, NEVER blindly abort.
   Commit the resolution.
4. HARD GATE (post-merge): run the FULL test suite on ${integ}.
   - If RED — a conflict you could not cleanly resolve, OR a semantic conflict that merged cleanly
     but broke behaviour — roll back THIS ONE merge: \`git merge --abort\` if mid-merge, else
     \`git reset --hard HEAD~1\`. Set result="failed", testsPassed=false, issueClosed=false, STOP.
     The issue stays OPEN for a later round; its branch progress is preserved.
5. Clean merge AND green suite → the issue has LANDED (landed means "on ${integ}", NOT "shipped" —
   a human still owns the merge into the base branch). Close it with a comment whose FIRST LINE is
   exactly:
     Landed on \`${integ}\` as <merge-commit-sha>.
   followed by a summary of what shipped. Use that body for the close:
   \`gh issue close ${t.number} ${repoFlag} --comment "..."\`. The branch name in that first line is
   what makes this run's closures findable later
   (\`gh issue list --state closed --search "${integ}"\`) if the draft PR is ever abandoned.
   Set result="clean", testsPassed=true, issueClosed=true, and report the merge commit sha.

NEVER fake a green suite. NEVER merge into anything but ${integ}.
Return ONLY the structured object.
`

const finalizePrompt = (integ, baseBranch, done, unfinished, stoppedBy) => `
You finalize an unattended implementation run. ${repoNote}

Integration branch: ${integ}. Base branch: ${baseBranch}.
Landed & closed: ${done.map(n => '#' + n).join(', ') || 'none'}.
Provisional unfinished: ${unfinished.map(u => `#${u.number} (${u.reason})`).join(', ') || 'none'}.
Stopped by: ${stoppedBy}.

1. Reconcile unfinished work before reporting:
   - Freshly list open issues carrying "${LABEL}" and keep only concrete buildable leaves.
   - Treat the workflow-owned completed list above as authoritative even if a GitHub read lags.
   - Union those open buildable leaves with the provisional unfinished list, deduplicate by number,
     and sort ascending. Preserve existing reasons; use "not reached (${stoppedBy})" for newly found
     leaves. Do not include umbrella/spec issues. Return this complete list as "unfinished".
2. Cleanup worktrees: \`git worktree prune\` and remove any leftover under ../wf-worktrees.
3. ${PUSH
    ? `Push the integration branch: \`git push -u origin ${integ}\`. Then open a DRAFT PR into ${baseBranch}:
   \`gh pr create ${repoFlag} --draft --base ${baseBranch} --head ${integ} --title "Unattended implementation: ${done.length} issue(s)" --body "..."\`.
   In the PR body summarise per-issue what shipped and list every reconciled unfinished issue with
   its reason for human attention. The body MUST also carry this warning verbatim in substance:
   this branch has to be merged — or explicitly discarded with its closed issues reopened
   (\`gh issue list --state closed --search "${integ}"\`) — BEFORE the workflow is run again.
   A re-run cuts a fresh integration branch off ${baseBranch} without these commits, and the issues
   closed here are no longer eligible for release, so their work would silently go missing.
   Report pushed=true and the PR url.`
    : `Do NOT push (offline mode). Leave the integration branch local. Report pushed=false.`}
NEVER merge into ${baseBranch} — a human owns that final gate.
Return ONLY the structured object.
`

// ---- Orchestration ---------------------------------------------------------
log(`implement-issues v3 — label="${LABEL}", maxRounds=${MAX_ROUNDS}, k=${MAX_ATTEMPTS}, push=${PUSH}`)

phase('Preflight')
const pre = await agent(preflightPrompt, { ...M.gate, schema: PREFLIGHT_SCHEMA, phase: 'Preflight', label: 'preflight' })
if (!pre) { log('preflight agent failed — aborting'); return { aborted: 'preflight-failed' } }
if (!pre.baseGreen) { log(`baseline RED — aborting: ${pre.summary}`); return { aborted: 'baseline-red', detail: pre.summary } }
const integ = pre.integrationBranch
const baseBranch = pre.baseBranch
log(`baseline green; integration branch = ${integ} (base ${baseBranch})`)

const done = []                 // issue numbers landed on the integration branch and closed
const attempts = new Map()      // issue number -> failure count (implement-fail or merge-rollback), persists across rounds
const setAside = new Map()      // issue number -> reason (hit the attempt cap; excluded from later rounds)
const knownCandidates = new Map() // issue number -> latest title/deferral evidence
const bump = (n, why) => {
  const c = (attempts.get(n) ?? 0) + 1
  attempts.set(n, c)
  if (c >= MAX_ATTEMPTS && !setAside.has(n)) setAside.set(n, `${c} failed attempt(s): ${why}`)
}
const rememberPlan = (plan) => {
  for (const t of plan.candidates) knownCandidates.set(t.number, { title: t.title })
  for (const d of plan.deferred) knownCandidates.set(d.number, { title: d.title, reason: d.reason })
}

let round = 0
let stop = null
while (round < MAX_ROUNDS) {
  round++
  const pn = `Round ${round}`

  if (budget.total && budget.remaining() < 120_000) {
    log(`budget low (${Math.round(budget.remaining() / 1000)}k) — stopping before round ${round}`)
    stop = 'budget'; break
  }

  phase(pn)
  const setAsideList = [...setAside.keys()]
  let plan = await agent(planPrompt(round, setAsideList, done), { ...M.plan, schema: PLAN_SCHEMA, phase: pn, label: `plan:r${round}` })
  if (!plan) { log(`round ${round}: planner failed — ending run for safety`); stop = 'plan-failed'; break }

  let classification = classifyPlan(plan, done, setAsideList)
  if (classification.kind !== 'ready') {
    log(`round ${round}: ${classification.kind} plan — running independent confirmation`)
    const confirmed = await agent(planPrompt(round, setAsideList, done, 'confirmation'), {
      ...M.plan, schema: PLAN_SCHEMA, phase: pn, label: `confirm:r${round}`,
    })
    if (!confirmed) { log(`round ${round}: confirmation failed`); stop = 'plan-failed'; break }
    plan = confirmed
    classification = classifyPlan(plan, done, setAsideList)
  }

  if (classification.kind === 'invalid') {
    log(`round ${round}: confirmed invalid plan — ${classification.reason}`)
    stop = 'plan-invalid'; break
  }
  rememberPlan(plan)
  if (classification.kind === 'complete') {
    log(`round ${round}: confirmed complete — no eligible open leaf issues`)
    stop = 'complete'; break
  }
  if (classification.kind === 'blocked') {
    log(`round ${round}: confirmed blocked — ${plan.deferred.length} issue(s) wait on verified-open logical blockers`)
    stop = 'blocked'; break
  }

  log(`round ${round}: releasing [${plan.batch.map(t => '#' + t.number).join(', ')}]` +
      `${plan.deferred.length ? `; deferred ${plan.deferred.map(d => '#' + d.number).join(', ')}` : ''}`)

  // Fan-out: each issue builds (Sonnet /tdd) then reviews (Opus /code-review) in its own worktree.
  const builds = await parallel(plan.batch.map(t => async () => {
    const impl = await agent(implementPrompt(t, integ), { ...M.implement, schema: IMPLEMENT_SCHEMA, phase: pn, label: `impl:#${t.number}` })
    if (!impl || impl.status !== 'success' || !impl.testsPassed || !impl.committed) {
      return { number: t.number, buildOk: false, summary: impl?.summary ?? 'implement agent died' }
    }
    // Review runs ONLY when the implement stage produced commits (D9).
    const rev = await agent(reviewPrompt(t, integ), { ...M.review, schema: REVIEW_SCHEMA, phase: pn, label: `review:#${t.number}` })
    return { number: t.number, buildOk: true, reviewOk: !!(rev && rev.status === 'success'), summary: rev?.summary ?? impl.summary }
  }))

  // Serial merge behind the hard full-suite gate (this per-merge run IS the barrier — no separate layer gate).
  for (let k = 0; k < plan.batch.length; k++) {
    const t = plan.batch[k]
    const b = builds[k]
    if (!b || !b.buildOk) {
      bump(t.number, 'build failed')
      log(`#${t.number} build failed (${attempts.get(t.number)}/${MAX_ATTEMPTS})${setAside.has(t.number) ? ' — set aside' : ''}`)
      continue
    }
    // Review is a gate, not advice (ADR 0002): an unreviewed build never lands.
    if (!b.reviewOk) {
      bump(t.number, 'review did not pass')
      log(`#${t.number} review failed — not merging (${attempts.get(t.number)}/${MAX_ATTEMPTS})${setAside.has(t.number) ? ' — set aside' : ''}`)
      continue
    }

    const merge = await agent(mergePrompt(t, integ), { ...M.merge, schema: MERGE_SCHEMA, phase: pn, label: `merge:#${t.number}` })
    if (merge && merge.result === 'clean' && merge.testsPassed && merge.issueClosed) {
      done.push(t.number)
      log(`#${t.number} integrated (${merge.commit ?? 'merged'}) and closed`)
    } else {
      bump(t.number, merge?.summary ?? 'merge agent died')
      log(`#${t.number} merge rolled back (${attempts.get(t.number)}/${MAX_ATTEMPTS})${setAside.has(t.number) ? ' — set aside' : ''}`)
    }
  }
}

// Everything observed but not landed, including candidates never attempted.
const stoppedBy = stop ?? 'max-rounds'
const unfinishedByNumber = new Map()
for (const [n, info] of knownCandidates) {
  if (!done.includes(n)) unfinishedByNumber.set(n, { number: n, reason: info.reason ?? `not reached (${stoppedBy})` })
}
for (const [n, c] of attempts) {
  if (done.includes(n)) continue
  unfinishedByNumber.set(n, {
    number: n,
    reason: setAside.get(n) ?? unfinishedByNumber.get(n)?.reason ?? `attempted ${c}x, not landed (${stoppedBy})`,
  })
}
for (const [n, reason] of setAside) {
  if (!done.includes(n)) unfinishedByNumber.set(n, { number: n, reason })
}
const unfinished = [...unfinishedByNumber.values()].sort((a, b) => a.number - b.number)

phase('Finalize')
const fin = await agent(finalizePrompt(integ, baseBranch, done, unfinished, stoppedBy), {
  ...M.gate, schema: FINALIZE_SCHEMA, phase: 'Finalize', label: 'finalize',
})
const finalUnfinished = fin?.unfinished ?? unfinished

log(`done: ${done.length} landed, ${finalUnfinished.length} left open, ${round} round(s), stop=${stoppedBy}`)
return {
  integrationBranch: integ,
  baseBranch,
  completed: done,
  unfinished: finalUnfinished,
  setAside: [...setAside.entries()].map(([number, reason]) => ({ number, reason })),
  rounds: round,
  stoppedBy,
  pr: fin?.prUrl ?? null,
  pushed: fin?.pushed ?? false,
}
