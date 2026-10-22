# Running a sub-project

How a sub-project goes from idea to merge, in this repo and in the colony game (`pedro-gn/colony`, which mirrors this
file). The rules exist to cut tokens and time without losing quality. They were measured on SP7–SP13 (2026-10-22):
- one long implementer agent reread its whole context on every call. Its context grew to ~960k tokens (average 390k),
  and it spent ~80% of a sub-project's tokens;
- full test suites ran 20–36 times per sub-project;
- review rounds repeated full e2e runs.

## Flow

1. **Brainstorm → spec → plan**, in the main conversation (superpowers skills).
   - Code mapping for the plan goes to cheap read-only agents (`Explore` or `feature-dev:code-explorer`, model
     sonnet), in parallel.
   - A builder check reads the spec once.
2. **The plan is cut into stages** of 2–4 tasks, each ending in something testable. The engine's work is its own
   stage, first.
   - Each task carries a model tag: `[light]` (mechanical: items, strings, fixtures, tables, UI wiring, renames) or
     `[heavy]` (navigation, reach / never-trapped rules, simulation logic, engine internals, concurrency).
   - Each stage ends with a **stage gate**: the full unit suite, typecheck, and the stage's perf gates.
3. **One fresh implementer per stage, in sequence.** Never one agent for the whole plan.
   - The agent is `stage-implementer` (opus). A stage whose tasks are all `[light]` uses `light-implementer` (sonnet).
   - The next stage's agent starts from the plan, the spec, the ledger and git; it gets no transcript.
   - Still one agent working at a time, then one reviewer.
4. **Engine stage → quick review before the game builds on it.** `fast-reviewer` on the engine diff only (~10 min).
   - Fix what it finds before the next stage starts.
5. **End:**
   - `fast-reviewer` on the whole branch;
   - **at the same time**, the full e2e suite runs once, in the background;
   - one fix round by a fresh `stage-implementer` given the review file.
   - Re-verify only Critical findings, and only through the repro test the fixer wrote. No second full review.
6. **Merge after the user's acceptance.** Engine first, then the game.
   - Push only with the user's OK.
   - Then **start a new conversation** for the next sub-project. Memory, the spec, the plan and the ledger carry the
     state; a conversation that spans many sub-projects rereads hundreds of thousands of tokens on every turn.

## Tests

- **Per task:** only the task's own test files and the tests the plan names for it, plus typecheck.
  - `vitest related` is not narrow here: one colony source file pulls about 60 of the ~130 test files, and one engine
    file about 80. Use it at most once per stage, not per task.
- **Full unit suite and typecheck:** once per stage (the stage gate) and once before merge.
- **e2e (Playwright):**
  - never per task;
  - the new spec once, in the last stage;
  - the full suite once, in parallel with the final review.
  - Known flakes are named in the ledger and rerun alone; they are not fixed in passing.
- **Perf gates** (mesher < 3 ms, reach guard): at stage gates, and only for stages that touch them.
- **Evidence:** outputs used as evidence are redirected to a file and read from it (the shell proxy summarises
  output).

## Ledger (`*.progress.md`)

- **Per task, at most ~15 lines:**
  - what changed;
  - RED → GREEN, as test names and the log path;
  - deviations, one line each (`Dn: what — why`).
- Logs stay in files; never paste them into the ledger.
- The agent reads the ledger's last stage and the deviation list, not the whole history.

## Reviews (`fast-reviewer`)

- **Time-boxed to ~30 minutes.**
- **Reads:** the diff against the plan's Review Focus and the spec's anti-goals.
- **Runs:** only targeted test files, plus a throwaway repro test outside the repo for each suspicion. No full suites,
  no e2e, no benches.
- **Reports:** Critical / Important / Minor, each with file:line, a concrete failure scenario and a one-line fix. It
  also lists which Review Focus items it checked and found fine.
- The main conversation saves the report to `docs/reviews/YYYY-MM-DD-<topic>-review.md` in the repo that owns the
  sub-project.
