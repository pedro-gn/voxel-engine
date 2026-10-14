# SDD ledger — plan: docs/superpowers/plans/2026-10-14-game-hooks.md

Executor: inline (superpowers:executing-plans), single implementer. Branch renamed to `feat/game-hooks` (base 56f5883).
Ledger kept in the repo (committed with each task) at the user's request instead of the git-ignored workspace.

## Pre-flight (shared interfaces)

- Task 1 → Tasks 4/5: `WorkerSystem.spawnControlled/despawnControlled/goTo/work/stop` are stubs in Task 1, implemented in 4/5; the context's `units` calls them. Consistent.
- Task 1 → Task 2: `SystemRunner.snapshot()/restore()`, `SystemSection`. Consistent.
- Task 1/2 → Task 3: `TickResult.systems`, `checkSystemSections`. Consistent.
- Task 6 → Task 7: `Simulation.setVoid` calls `workers.setVoid` (stub in 6, filled in 7). Consistent.
- Task 6 → Task 8: `Simulation.voidWorld`, `CollapseTick.removed`. Consistent.
- Task 9 → Task 10: `job.cut`/`result.cut`, `CutPlane`. Consistent.
- Tasks 1–12 → Task 13: public API only (`@elovox/engine`, `@elovox/engine/sim-worker`). Consistent.

## Standing rulings (from the user's brief)

- Ruling: no benchmark is run in this execution (BENCH_CUT, `bench:node` in Task 9 step 3, any other) — the user may be gaming and benchmarks need a quiet machine — cost if wrong: a perf regression or a missed 150 ms cut target is found later by the user, not here.
- Ruling: Task 14 step 5 (user checkpoints) is left pending for the user — cost if wrong: none; tuning of keyframes/CUT_SHADE/VOID_FADE_BLOCKS waits for them.

## Tasks

- Task 1: Ruling: step 5's RED was "simulation ignores systems" rather than "cannot resolve systems.ts" (test file and module were written in one go) — the 10 failing assertions showed the same missing behaviour — cost if wrong: none.
- Task 1: Ruling: `SystemContext.edit` also refuses an invalid voxel value (`invalid voxel N`, like `RuleContext.set`) — the plan passed it unchecked to `applySet` — cost if wrong: a system that relied on writing garbage voxels gets an exception (programming error anyway).
- Task 1: Ruling: `waterDepth` doc says "water above the bottom of the cell" (what `WaterSystem.depthAt` returns: immersion above the feet, can exceed 256) instead of "water in the cell" — cost if wrong: doc wording only.
- Task 1: complete (commit c658716; tests: vitest systems/rng/simulation/commands → 4 files, 47 passed; root typecheck 0)
