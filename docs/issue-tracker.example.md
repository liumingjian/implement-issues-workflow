# Issue tracker: GitHub

This repo's issues are managed as GitHub Issues via the `gh` CLI. Infer the repo from the
current `origin`.

## Conventions
- **Read an issue**: `gh issue view <number> --comments`
- **List agent-ready issues**: `gh issue list --state open --label "ready-for-agent" --json number,title,labels,assignees`
- **Comment**: `gh issue comment <number> --body "..."`
- **Labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

## Blocking
Use GitHub native issue dependencies. The `blocked_by` endpoint reports relationship members; it
does not by itself prove that a blocker is still open. First discover blocker numbers:
`gh api repos/<owner>/<name>/issues/<number>/dependencies/blocked_by --jq '.[].number'`

Then fetch each returned issue's current lifecycle state:
`gh issue view <blocker-number> --json number,state --jq '{number,state}'`

A ticket is blocked only while at least one blocker is `OPEN`; `CLOSED` blockers are satisfied.

## Claim
Before starting a ticket: `gh issue edit <number> --add-assignee @me`.

## Resolve
Post a resolution comment summarising what shipped, then close the issue.
