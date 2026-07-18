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
Use GitHub native issue dependencies. A ticket is buildable only when every issue in its
`blocked_by` set is CLOSED. Query with:
`gh api repos/<owner>/<name>/issues/<number>/dependencies/blocked_by`

## Claim
Before starting a ticket: `gh issue edit <number> --add-assignee @me`.

## Resolve
Post a resolution comment summarising what shipped, then close the issue.
