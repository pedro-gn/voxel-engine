## Agent skills

### Issue tracker

GitHub Issues on `pedro-gn/voxel-engine` via `gh`; external PRs are also triaged as requests. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Sub-project execution

Every sub-project (engine or colony) follows `docs/agents/subprojects.md`:
- the plan is cut into stages;
- one fresh `stage-implementer` (or `light-implementer` for `[light]` stages) per stage, in sequence;
- a `fast-reviewer` after the engine stage and at the end, with the full e2e suite running in parallel;
- only the task's own tests per task, full suites only at stage gates;
- short ledgers;
- a new conversation after each merge.
