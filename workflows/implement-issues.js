export const meta = {
  name: 'implement-issues',
  description: 'Unattended implement loop: discover ready-for-agent issues, respect blocking edges, build each in fresh context via TDD + code-review, until the frontier is dry',
  whenToUse: 'Run the /implement discipline over a whole backlog without babysitting. Works against any repo that follows the Matt-Pocock issue-tracker convention (docs/agents/issue-tracker.md).',
  phases: [
    { title: 'Scan', detail: 'find the next unblocked ready-for-agent ticket' },
    { title: 'Implement', detail: 'one fresh agent per ticket: TDD red-green then code-review then commit + close' },
  ],
}

// ---- Config (all optional, via args) ---------------------------------------
const REPO   = args?.repo   ?? null           // e.g. "owner/name"; null => infer from origin
const LABEL  = args?.label  ?? 'ready-for-agent'
const MAX    = args?.max    ?? 50             // hard cap on tickets built this run
const DRY    = args?.dryRun ?? false          // true => plan only, never implement/commit
const repoFlag = REPO ? `--repo ${REPO}` : ''
const repoNote = REPO ? `Repository: ${REPO}.` : 'Infer the repo from the current git origin.'

// ---- Schemas ---------------------------------------------------------------
const FRONTIER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ticket: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: {
        number: { type: 'integer' },
        title: { type: 'string' },
        blockersClosed: { type: 'boolean' },
      },
      required: ['number', 'title', 'blockersClosed'],
    },
    readyOpenCount: { type: 'integer' },
    blockedWaiting: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { number: { type: 'integer' }, openBlockers: { type: 'array', items: { type: 'integer' } } },
        required: ['number', 'openBlockers'],
      },
    },
    reason: { type: 'string' },
  },
  required: ['ticket', 'readyOpenCount', 'blockedWaiting', 'reason'],
}

const IMPLEMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    number: { type: 'integer' },
    status: { type: 'string', enum: ['success', 'failed', 'skipped'] },
    testsPassed: { type: 'boolean' },
    codeReviewPassed: { type: 'boolean' },
    committed: { type: 'boolean' },
    issueClosed: { type: 'boolean' },
    commit: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['number', 'status', 'testsPassed', 'codeReviewPassed', 'committed', 'issueClosed', 'summary'],
}

// ---- Prompts ---------------------------------------------------------------
const frontierPrompt = (excluded) => `
You are the FRONTIER scanner for an unattended implementation loop. Do NOT write any code.

${repoNote}

First read docs/agents/issue-tracker.md to learn this repo's exact tracker conventions
(how to list issues, read labels, and query blocking dependencies). Follow that file — the
commands below are the GitHub default and may need adapting.

Goal: pick the SINGLE best next ticket to implement, respecting blocking edges.

Steps:
1. List open issues carrying the "${LABEL}" label:
   gh issue list ${repoFlag} --state open --label "${LABEL}" --json number,title,assignees
2. For EACH candidate, query its blockers (GitHub native dependencies):
   gh api repos/<owner>/<name>/issues/<number>/dependencies/blocked_by --jq '.[].number'
   A candidate is ELIGIBLE only if every blocker issue is CLOSED (or it has no blockers).
3. Exclude any ticket already attempted this run: [${excluded.join(', ') || 'none'}].
4. Among eligible, prefer the lowest issue number (blockers-first, stable order).
5. Return that ticket as "ticket". If none is eligible, return ticket = null and explain in
   "reason" (e.g. "3 ready tickets remain but all are blocked by open issues").

Report the counts honestly in readyOpenCount and blockedWaiting. Return ONLY the structured object.
`

const implementPrompt = (t) => `
You are an IMPLEMENTER agent. You own exactly ONE ticket end-to-end, in a fresh context, and
must follow the /implement discipline. ${repoNote}

Ticket: #${t.number} — "${t.title}"

DISCIPLINE (do these in order):
0. Read docs/agents/issue-tracker.md for the exact tracker ops (claim / comment / close).
1. Fetch the ticket and its full thread:  gh issue view ${t.number} ${repoFlag} --comments
   Read the spec carefully. Read CONTEXT.md / ADRs / any referenced docs so you match intent.
2. Claim it:  gh issue edit ${t.number} ${repoFlag} --add-assignee @me
3. BUILD test-first (drive /tdd internally): for each behavioural slice, write a failing test
   (RED), make it pass with the minimum code (GREEN), refactor if warranted. Repeat slice by
   slice until the ticket's spec is satisfied. Keep changes surgical — only what the ticket asks.
4. Run the full test suite and any typecheck/lint the repo uses; everything must be green.
5. CODE REVIEW the diff on two axes before committing:
   - Standards: does it follow this repo's documented coding standards?
   - Spec: does the diff actually deliver what issue #${t.number} asked for?
   Fix anything that fails. Do NOT commit a diff that fails either axis.
${DRY ? '6. DRY RUN: do NOT commit and do NOT close the issue. Report what you would have done.' : `6. Commit the work with a message referencing #${t.number}. (Do not push unless the repo/CI convention requires it.)
7. Resolve per the tracker: post a resolution comment summarising what shipped, then close:
   gh issue close ${t.number} ${repoFlag} --comment "..."`}

If you get genuinely stuck (spec ambiguous, blocker surfaces, tests can't be made green),
STOP — set status "failed", leave the issue open, and explain precisely in "summary" so a
human can pick it up. Never fake green tests or a passing review.

Return ONLY the structured object describing the real outcome.
`

// ---- Orchestration ---------------------------------------------------------
log(`implement-issues starting — label="${LABEL}", max=${MAX}${DRY ? ', DRY RUN' : ''}`)

const results = []
const attempted = []          // ticket numbers we've tried (success or fail) — never retried
let consecutiveFailures = 0

while (results.length < MAX) {
  if (budget.total && budget.remaining() < 80_000) {
    log(`budget low (${Math.round(budget.remaining() / 1000)}k left) — stopping before next ticket`)
    break
  }

  phase('Scan')
  const f = await agent(frontierPrompt(attempted), {
    schema: FRONTIER_SCHEMA, phase: 'Scan', label: 'scan-frontier',
  })

  if (!f) { log('frontier scan failed/skipped — stopping'); break }
  if (!f.ticket) {
    log(`frontier dry: ${f.reason} (ready-open=${f.readyOpenCount}, blocked=${f.blockedWaiting.length})`)
    break
  }

  const t = f.ticket
  attempted.push(t.number)
  log(`→ implementing #${t.number} "${t.title}"  (${f.readyOpenCount} ready, ${f.blockedWaiting.length} still blocked)`)

  phase('Implement')
  const r = await agent(implementPrompt(t), {
    schema: IMPLEMENT_SCHEMA, phase: 'Implement', label: `impl:#${t.number}`,
  })

  if (!r) {
    results.push({ number: t.number, status: 'failed', summary: 'agent died / skipped' })
    consecutiveFailures++
  } else {
    results.push(r)
    log(`#${r.number}: ${r.status} — ${r.summary.slice(0, 120)}`)
    consecutiveFailures = r.status === 'success' ? 0 : consecutiveFailures + 1
  }

  if (consecutiveFailures >= 2) {
    log('two consecutive failures — halting the loop for human review')
    break
  }
}

const ok = results.filter(r => r.status === 'success')
log(`done: ${ok.length}/${results.length} tickets succeeded`)

return {
  built: results.length,
  succeeded: ok.map(r => r.number),
  failed: results.filter(r => r.status !== 'success').map(r => ({ number: r.number, summary: r.summary })),
  results,
}
