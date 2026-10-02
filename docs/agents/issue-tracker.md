# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues on **`pedro-gn/voxel-engine`**. Use the `gh` CLI for all operations.

**Repo targeting:** `origin` points at `https://github.com/pedro-gn/voxel-engine`, so `gh` infers the repo inside this clone. The `-R pedro-gn/voxel-engine` flag below is kept explicit so commands also work from worktrees or other directories.

## Conventions

- **Create an issue**: `gh issue create -R pedro-gn/voxel-engine --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> -R pedro-gn/voxel-engine --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list -R pedro-gn/voxel-engine --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> -R pedro-gn/voxel-engine --body "..."`
- **Apply / remove labels**: `gh issue edit <number> -R pedro-gn/voxel-engine --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> -R pedro-gn/voxel-engine --comment "..."`

## Pull requests as a triage surface

**PRs as a request surface: yes.** _(`/triage` reads this flag.)_

PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> -R pedro-gn/voxel-engine --comments` and `gh pr diff <number> -R pedro-gn/voxel-engine` for the diff.
- **List external PRs for triage**: `gh pr list -R pedro-gn/voxel-engine --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close` (each with `-R pedro-gn/voxel-engine`).

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue on `pedro-gn/voxel-engine`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> -R pedro-gn/voxel-engine --comments`.
