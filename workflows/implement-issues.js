export const meta = {
  name: 'implement-issues',
  description: 'Unattended DAG-parallel implement loop: build the ticket DAG (leaf tickets only), auto-review the plan, then build each topological layer in parallel worktrees behind hard test gates, integrating onto a branch for human review',
  whenToUse: 'Run the /implement discipline over a whole backlog without babysitting, exploiting the dependency DAG for parallelism. Works against any repo following the Matt-Pocock issue-tracker convention (docs/agents/issue-tracker.md). Zero changes to the Matt skills.',
  phases: [
    { title: 'Preflight', detail: 'baseline test gate + create integration branch' },
    { title: 'Plan', detail: 'build leaf-ticket DAG, topological layers' },
    { title: 'Review', detail: 'auto-reviewer vets the plan (abort power)' },
    { title: 'Execute', detail: 'per layer: parallel worktree builds -> serial integration behind test gates' },
    { title: 'Finalize', detail: 'push integration branch + open draft PR' },
  ],
}

// ---- Config (all optional, via args) ---------------------------------------
const REPO     = args?.repo    ?? null
const LABEL    = args?.label   ?? 'ready-for-agent'
const RETRIES  = args?.retries ?? 1          // conflict re-runs per ticket before giving up
const PUSH     = args?.push    ?? true       // push integration branch + open draft PR
const repoFlag = REPO ? `--repo ${REPO}` : ''
const repoNote = REPO ? `Repository: ${REPO}.` : 'Infer the repo from the current git origin.'

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

const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    layers: { type: 'array', items: { type: 'array', items: TICKET } },
    excluded: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { number: { type: 'integer' }, reason: { type: 'string' } },
        required: ['number', 'reason'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['layers', 'excluded', 'summary'],
}

const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['proceed', 'abort'] },
    layers: { type: 'array', items: { type: 'array', items: TICKET } }, // possibly-corrected
    fixes: { type: 'array', items: { type: 'string' } },
    concerns: { type: 'array', items: { type: 'string' } },
    reason: { type: 'string' },
  },
  required: ['verdict', 'layers', 'fixes', 'concerns', 'reason'],
}

const BUILD_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    number: { type: 'integer' },
    status: { type: 'string', enum: ['success', 'failed'] },
    branch: { type: 'string' },
    testsPassed: { type: 'boolean' },
    reviewPassed: { type: 'boolean' },
    summary: { type: 'string' },
  },
  required: ['number', 'status', 'branch', 'testsPassed', 'reviewPassed', 'summary'],
}

const INTEGRATE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    number: { type: 'integer' },
    result: { type: 'string', enum: ['clean', 'conflict'] },
    integrationTestsPassed: { type: 'boolean' },
    issueClosed: { type: 'boolean' },
    commit: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['number', 'result', 'integrationTestsPassed', 'issueClosed', 'summary'],
}

const GATE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { green: { type: 'boolean' }, summary: { type: 'string' } },
  required: ['green', 'summary'],
}

const FINALIZE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    pushed: { type: 'boolean' },
    prUrl: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['pushed', 'summary'],
}

// ---- Prompts ---------------------------------------------------------------
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

const planPrompt = `
You are the PLANNER. ${repoNote} Do NOT write code. Build the implementation DAG.

1. Read docs/agents/issue-tracker.md for tracker conventions.
2. List OPEN issues carrying the "${LABEL}" label:
   gh issue list ${repoFlag} --state open --label "${LABEL}" --json number,title
3. SELECT ONLY LEAF TICKETS. Both /to-spec (specs) and /to-tickets (tickets) carry "${LABEL}",
   so the label alone is NOT enough. A spec/umbrella is a PARENT issue (it has sub-issues); an
   implementable ticket is a LEAF. For each candidate check:
   gh api repos/<owner>/<name>/issues/<number> --jq '.sub_issues_summary.total'
   Keep it ONLY if that total is 0. Put every excluded issue (with total>0, i.e. an umbrella
   spec) into "excluded" with a reason. Also semantically double-check: if a leaf still clearly
   reads as a scope/spec document rather than a concrete buildable behaviour, exclude it too.
4. For each remaining leaf, query its blockers:
   gh api repos/<owner>/<name>/issues/<number>/dependencies/blocked_by --jq '.[].number'
   Only edges among the selected leaf tickets matter (ignore blockers that are closed or not in
   the set).
5. Build the DAG and produce TOPOLOGICAL LAYERS: layer 0 = tickets with no open blocker in the
   set; layer k = tickets whose blockers all live in layers < k. Tickets within a layer are
   mutually independent and safe to build in parallel. Order layers 0..N; within a layer order
   by ascending issue number.
Return ONLY the structured object (layers as arrays of {number,title}).
`

const reviewPrompt = (plan) => `
You are the PLAN REVIEWER — the only safeguard before code gets written unattended. You have
ABORT POWER. ${repoNote}

Here is the proposed plan:
${JSON.stringify(plan, null, 2)}

Vet it on two levels:
A. STRUCTURE — cycles, mis-layering, or any umbrella/spec issue that slipped in (re-check
   sub_issues_summary.total via gh api if unsure). Structural problems you can safely fix
   yourself: drop mis-included specs, break an obviously-wrong cycle, re-order a layer. Apply
   those fixes and return the corrected "layers", listing what you changed in "fixes".
B. DIRECTION — does the sequencing make sense? Any ticket whose real dependency is missing from
   the graph, or a layer that clearly cannot be built safely in parallel? These are MAJOR doubts
   you must NOT silently fix.

Verdict:
- "proceed" if structure is sound (after your fixes) and you have no major directional doubt.
  Return the final "layers" to execute.
- "abort" if you have a major directional concern — list it in "concerns" and explain in
  "reason". Do NOT proceed on a plan you doubt; a bad DAG means bulk-wrong code changes.
Return ONLY the structured object.
`

const buildPrompt = (t, integrationBranch, attempt) => `
You build EXACTLY ONE ticket in an ISOLATED git worktree. Never touch the main working tree or
the integration branch directly. ${repoNote}

Ticket #${t.number} — "${t.title}". Integration branch: ${integrationBranch}. Attempt: ${attempt}.
${attempt > 1 ? 'A previous attempt CONFLICTED at integration; you are rebuilding against the now-updated integration tip.' : ''}

Steps:
0. Read docs/agents/issue-tracker.md and the coding-standards doc (CLAUDE.md).
1. Claim the ticket: gh issue edit ${t.number} ${repoFlag} --add-assignee @me
2. Read it fully: gh issue view ${t.number} ${repoFlag} --comments
3. Create an isolated worktree branched from the CURRENT tip of ${integrationBranch}:
     root=$(git rev-parse --show-toplevel)
     wt="$root/../wf-worktrees/ticket-${t.number}-a${attempt}"
     git worktree add -B wf/ticket-${t.number}-a${attempt} "$wt" ${integrationBranch}
   Do ALL work inside "$wt".
4. Install dependencies there if the project needs them (e.g. npm install).
5. Build TEST-FIRST — red → green, slice by slice — until the ticket's spec is satisfied. Keep
   changes surgical: only what this ticket asks for.
6. GATE (per-ticket): run the FULL test suite inside the worktree; it must be 100% green.
7. GATE (per-ticket): review your own diff on two axes — Standards (repo coding standards) and
   Spec (does the diff deliver exactly what #${t.number} asked?). Fix until BOTH pass.
8. Commit to branch wf/ticket-${t.number}-a${attempt} with a message referencing #${t.number}.
   Do NOT merge, do NOT push, do NOT close the issue — integration is a separate step.
9. Report status "success" and branch = "wf/ticket-${t.number}-a${attempt}".

If you cannot make the suite green or the spec is ambiguous, STOP: status "failed", leave the
issue open, explain precisely. NEVER fake a green suite or a passing review.
Return ONLY the structured object.
`

const integratePrompt = (number, branch, integrationBranch) => `
You integrate ONE already-built, already-reviewed ticket branch into the integration branch and
verify it. Work in the MAIN working tree. ${repoNote}

Ticket #${number}. Source branch: ${branch}. Integration branch: ${integrationBranch}.

1. git checkout ${integrationBranch}
2. git merge --no-ff ${branch} -m "Integrate #${number}"
   - If git reports merge CONFLICTS: run \`git merge --abort\`, set result="conflict",
     issueClosed=false, and STOP.
3. GATE (post-merge integration): run the FULL test suite on ${integrationBranch}.
   - If RED (a semantic conflict that merged cleanly but broke behaviour): undo the merge with
     \`git reset --hard HEAD~1\`, set result="conflict", integrationTestsPassed=false,
     issueClosed=false, and STOP.
4. If the merge is clean AND the suite is green: this ticket has truly landed. Now resolve it —
   post a resolution comment on #${number} summarising what shipped, then
   \`gh issue close ${number} ${repoFlag} --comment "..."\`. Set result="clean",
   integrationTestsPassed=true, issueClosed=true, and report the merge commit sha.
Return ONLY the structured object.
`

const layerGatePrompt = (integrationBranch, n) => `
You are the LAYER ${n} BARRIER gate. In the main working tree, checkout ${integrationBranch} and
run the FULL test suite once more. Report green=true only if 100% pass. Do not change any code.
Return ONLY the structured object.
`

const finalizePrompt = (integrationBranch, baseBranch, done, failed) => `
You finalize an unattended implementation run. ${repoNote}

Integration branch: ${integrationBranch}. Base branch: ${baseBranch}.
Completed tickets: ${done.join(', ') || 'none'}. Failed/left-open: ${failed.map(f => '#' + f.number).join(', ') || 'none'}.

1. Cleanup worktrees: \`git worktree prune\` and remove any leftover under ../wf-worktrees.
2. ${PUSH
    ? `Push the integration branch: \`git push -u origin ${integrationBranch}\`. Then open a DRAFT PR into ${baseBranch}:
   \`gh pr create ${repoFlag} --draft --base ${baseBranch} --head ${integrationBranch} --title "Unattended implementation: ${done.length} tickets" --body "..."\`.
   In the PR body summarise per-ticket what shipped and list any failed/left-open tickets for human attention. Report pushed=true and the PR url.`
    : `Do NOT push (offline mode). Leave the integration branch local. Report pushed=false.`}
NEVER merge into ${baseBranch} — a human owns that final gate.
Return ONLY the structured object.
`

// ---- Orchestration ---------------------------------------------------------
log(`implement-issues v2 — label="${LABEL}", retries=${RETRIES}, push=${PUSH}`)

phase('Preflight')
const pre = await agent(preflightPrompt, { schema: PREFLIGHT_SCHEMA, phase: 'Preflight', label: 'preflight' })
if (!pre) { log('preflight agent failed — aborting'); return { aborted: 'preflight-failed' } }
if (!pre.baseGreen) { log(`baseline RED — aborting: ${pre.summary}`); return { aborted: 'baseline-red', detail: pre.summary } }
const integ = pre.integrationBranch
const baseBranch = pre.baseBranch
log(`baseline green; integration branch = ${integ} (base ${baseBranch})`)

phase('Plan')
const plan = await agent(planPrompt, { schema: PLAN_SCHEMA, phase: 'Plan', label: 'plan' })
if (!plan || !plan.layers?.length || !plan.layers.some(l => l.length)) {
  log('no buildable leaf tickets found — nothing to do')
  return { aborted: 'empty-plan', excluded: plan?.excluded ?? [] }
}
log(`plan: ${plan.layers.length} layers, ${plan.layers.flat().length} tickets; excluded ${plan.excluded.length} spec/umbrella issues`)

phase('Review')
const rev = await agent(reviewPrompt(plan), { schema: REVIEW_SCHEMA, phase: 'Review', label: 'plan-review' })
if (!rev) { log('plan reviewer failed — aborting for safety'); return { aborted: 'review-failed' } }
if (rev.verdict === 'abort') {
  log(`plan reviewer ABORTED: ${rev.reason}`)
  return { aborted: 'reviewer-abort', concerns: rev.concerns, reason: rev.reason }
}
const layers = (rev.layers && rev.layers.some(l => l.length)) ? rev.layers : plan.layers
if (rev.fixes.length) log(`reviewer applied fixes: ${rev.fixes.join('; ')}`)

const done = []
const failed = []
let halted = false

for (let i = 0; i < layers.length && !halted; i++) {
  const layer = layers[i]
  if (!layer.length) continue
  const pn = `Layer ${i + 1}`
  phase(pn)
  log(`${pn}/${layers.length}: ${layer.length} ticket(s) [${layer.map(t => '#' + t.number).join(', ')}] — building in parallel worktrees`)

  if (budget.total && budget.remaining() < 120_000) {
    log(`budget low (${Math.round(budget.remaining() / 1000)}k) — stopping before layer ${i + 1}`)
    halted = true; break
  }

  // Parallel isolated builds (each agent manages its own git worktree)
  const builds = await parallel(layer.map(t => () =>
    agent(buildPrompt(t, integ, 1), { schema: BUILD_SCHEMA, phase: pn, label: `build:#${t.number}` })
  ))

  // Serial integration behind the post-merge test gate
  for (let k = 0; k < layer.length; k++) {
    const t = layer[k]
    const b = builds[k]
    if (!b || b.status !== 'success') {
      failed.push({ number: t.number, summary: b?.summary ?? 'build failed/agent died' })
      log(`#${t.number} build failed — halting layer for human review`)
      halted = true; break
    }

    let res = await agent(integratePrompt(t.number, b.branch, integ), { schema: INTEGRATE_SCHEMA, phase: pn, label: `integrate:#${t.number}` })

    // Conflict -> rebuild against updated tip, up to RETRIES
    let attempt = 1
    while (res && res.result === 'conflict' && attempt <= RETRIES) {
      attempt++
      log(`#${t.number} conflict at integration — rebuild attempt ${attempt} against updated ${integ}`)
      const rb = await agent(buildPrompt(t, integ, attempt), { schema: BUILD_SCHEMA, phase: pn, label: `rebuild:#${t.number}(a${attempt})` })
      if (!rb || rb.status !== 'success') { res = null; break }
      res = await agent(integratePrompt(t.number, rb.branch, integ), { schema: INTEGRATE_SCHEMA, phase: pn, label: `integrate:#${t.number}(a${attempt})` })
    }

    if (!res || res.result !== 'clean') {
      failed.push({ number: t.number, summary: res?.summary ?? 'unresolved conflict after retries' })
      log(`#${t.number} could not integrate — halting layer for human review`)
      halted = true; break
    }
    done.push(t.number)
    log(`#${t.number} integrated (${res.commit ?? 'merged'}) and closed`)
  }

  if (halted) break

  // Layer barrier gate
  const gate = await agent(layerGatePrompt(integ, i + 1), { schema: GATE_SCHEMA, phase: pn, label: `barrier:L${i + 1}` })
  if (!gate || !gate.green) {
    log(`layer ${i + 1} barrier RED — halting: ${gate?.summary ?? 'gate agent died'}`)
    halted = true; break
  }
  log(`layer ${i + 1} barrier green`)
}

phase('Finalize')
const fin = await agent(finalizePrompt(integ, baseBranch, done, failed), { schema: FINALIZE_SCHEMA, phase: 'Finalize', label: 'finalize' })

log(`done: ${done.length} integrated, ${failed.length} failed/left-open, halted=${halted}`)
return {
  integrationBranch: integ,
  baseBranch,
  completed: done,
  failed,
  halted,
  pr: fin?.prUrl ?? null,
  pushed: fin?.pushed ?? false,
}
