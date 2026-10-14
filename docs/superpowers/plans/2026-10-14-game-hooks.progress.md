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
- Task 2: complete (commit 4165a7b; tests: vitest systemsSave/savePackage/persistRoundTrip/simSnapshot → 26 passed; root typecheck 0)
- Task 3: Ruling (D10): `GameSystem.command` takes `CustomCommand` (`{ type: string; [k]: unknown }`) instead of `Command` — a `name:` command is never `setBlock`/`fillRegion`, and with the union a game cannot read `cmd.text` without a cast (the plan's own simHostSystems test did not type-check) — cost if wrong: none at runtime; a game that annotated the parameter as `Command` still type-checks (method parameter bivariance). `CustomCommand` is now exported from `@elovox/engine`.
- Task 3: Ruling: the plan's simHostSystems test declared `last` twice (a string and the tick); the string is named `said` — cost if wrong: none.
- Task 3: complete (commit 4062772; tests: vitest simHostSystems/simHost/systems → 28 passed; root typecheck 0)
- Task 4: Ruling: `fell` is only sent for a drop > 0 and its start height (`fallFrom`) is saved for a unit falling at save time (optional `UnitSnapshot.fallFrom`, D8 style) — without it a unit saved mid-fall reports a negative height after load — cost if wrong: one more optional field in the v1 workers section.
- Task 4: Ruling: controlled-unit fields are mixed into `WorkerSystem.mixState` only for controlled units (and `takeUnitEvents` is drained every unpaused tick even without systems) — keeps hashes of worlds without controlled units identical and bounds the event list — cost if wrong: none.
- Task 4: Ruling: `goTo` on a falling unit keeps it `falling` (the plan set `planning`, which reset `fallFrom` on the next fall() call); `spawnControlled`/`despawnControlled` wake all sleepers like the spawn/despawn commands; `spawnUnit` takes the checked pose (limit/pose/tool/stock checks stay with each caller, keeping the command's error precedence) — cost if wrong: none (behaviour of uncontrolled units unchanged; suites green).
- Task 4: added test "still assigns uncontrolled units next to a controlled one" (spec §7) and an unknown-id case to "throws for unknown or uncontrolled units".
- Task 4: complete (commit b74987f; tests: vitest controlledUnits/workers/workersRoutes/workersSnapshot/workersSleep/systems/determinism → 217 passed; root typecheck 0)
- Task 5: Ruling: no separate test for a lease timeout of a dig intent — the lapse goes through `block(u, 'traffic')`, which fails any dig/build intent (same hook the fall test covers via `fall()`); building a reliable lapse scenario would need a contrived traffic jam — cost if wrong: a regression in the lease path for controlled units would go unnoticed by the suite (Review Focus 1 reviewer check).
- Task 5: complete (commit 0216b68; tests: vitest controlledUnits/workers/workersRoutes/workersSnapshot/workersSleep/determinism/persistRoundTrip → 219 passed; root typecheck 0)
- Task 6: Ruling: the plan's void test world `[64, 48, 64]` is refused (sizes are multiples of 32); the tests use `[64, 64, 64]` — cost if wrong: none.
- Task 6: Ruling: the falling-block void test places the sand with `setBlock` (generation does not queue gravity checks) and a second test covers sand resting on y 0 (gravity's `open(y < 0)` is true in a void world, so it starts falling out) — cost if wrong: none.
- Task 6: Ruling: a fragment is removed once every run is entirely below the bottom (`(r.y + r.height) * 256 + offset <= 0`) and only when nothing would land it (`grid` unset), instead of the plan's "top cell below 0"; `removed` is also cleared at the start of each collapse step (like `landed`) — cost if wrong: a fragment is drawn one or two ticks longer below the island.
- Task 6: Ruling: `isVoid` is mixed into `Simulation.hash()` only when true (keeps other worlds' hashes) — cost if wrong: none.
- Task 6: added test "reports the void flag"; dropped my own extra assertion that the sea account ends positive (springs debit it unbounded, so it can stay negative while water still sits on the island).
- Task 6: complete (commit 7db72eb; tests: vitest voidWorld/gravity/collapse/waterWorld/waterCycle/waterColumns/fragments/determinism → 116 passed + 2 expected-fail (pre-existing); root typecheck 0)
- Task 7: Ruling: `regions.ts vacant()` returns `this.nav.voidFloor` at y 0 (the plan's `if (y === 0 && !voidFloor) return false` fell through to a uniform lookup at y −1) — a uniform open bottom tile is vacant in a void world — cost if wrong: none.
- Task 7: Ruling: `attached()` in a void world checks the neighbours of a y-0 cell (out-of-bounds reads are air) instead of refusing outright — building next to an island block on the bottom layer stays possible — cost if wrong: none.
- Task 7: Ruling: `kill()` also cancels orders left without crew (as `unitDespawn` does); added test "nothing is built against the bottom of a void world" (the test world's stone gains `buildTicks`) — cost if wrong: none.
- Task 7: complete (commit 8e4c6c4; tests: vitest voidUnits/navigation/regions/workers/workersRoutes/controlledUnits/voidWorld → 247 passed; root typecheck 0)
- Task 8: Ruling: the `voidFloor` uniform is module-level in `waterVertex.ts` next to `waterAlpha` (shared by the curtain and plain-curtain materials); `WaterMaterial.setVoidFloor` / `Visuals.setVoidFloor` set it — cost if wrong: two engines in one page share the flag (as they already share `waterAlpha`).
- Task 8: the curtain fade is not unit-tested (shader); it is checked by the e2e sky scene screenshots and user checkpoint 1.
- Task 8: complete (commit 61664d3; tests: vitest simHost/fragments/surfaceView/simHostSnapshot/simHostGen → 85 passed; root typecheck 0)
- Task 9: Ruling: `applyCut(s, oy, cut, opaque)` takes the opacity table, and `CutPlane.covered` is 0 (air above) / 1 (opaque above: the cut creates the top face, flagged CUT_BIT) / 2 (other non-air above, e.g. water or glass: the face already existed, not flagged) — decorations are skipped where covered ≠ 0 so a grass top that was under water does not sprout tufts when cut open — cost if wrong: none.
- Task 9: Ruling: `CUT_SHADE` lives in `vertexFormat.ts` next to `CUT_BIT`; the cutout material keeps its alpha (`vec4(rgb, albedo.a)`) — cost if wrong: none.
- Task 9: Ruling: the meshJob "uniform stone" test uses the middle chunk of a 96³ world (a chunk is only trivial when all six neighbours are uniform opaque chunks inside the world; the plan's 64³ setup has no such chunk) — cost if wrong: none.
- Task 9: Ruling: step 3's `npm run bench:node` (mesher 3 ms/chunk gate) NOT run (user's no-benchmark instruction) — pending for the user — cost if wrong: a mesher slowdown from the cut branch in the inner loop goes unmeasured.
- Task 9: complete (commit 52864ed; tests: vitest vertexFormat/greedy/meshJob/decorations/quadBuilder → 45 passed; root typecheck 0)
- Task 10: Ruling (D11): decorations are NOT hidden with their chunk (they are a separate `DecorationMeshes` with its own cull, contrary to the plan's "hidden chunks hide theirs"); `DecorationMeshes.setCut` leaves chunks the cut hides out of its selection and re-selects when the cut moves — cost if wrong: none (test added in decorationMeshes.test.ts, written after the code).
- Task 10: Ruling (D12): units are drawn by the game, not the engine, so the engine cannot hide them; it exposes `engine.view.cutY` and the sandbox hides units above it (Task 13) — cost if wrong: a game that forgets to read `cutY` shows units floating above the cut.
- Task 10: Ruling: "discard above the cut plane" uses three's `NodeMaterial.maskNode` (`belowCut()` = `positionWorld.y <= cutTop + 0.01`, layerCut.ts) instead of a hand-written `Discard(...)`: it discards in the fragment stage without a `select()` and three applies it to the shadow pass too — cost if wrong: none.
- Task 10: Ruling: the batch cut is a `cutTop` argument of `buildDrawList` (chunk skipped when its bottom is at or above the cut plane); `threeCull` (internal pixel-diff reference mode) ignores the cut — cost if wrong: the reference mode draws hidden chunks.
- Task 10: Ruling: picking and the orbit camera's ground use `cutGet` (air above the cut); stale cut results are dropped in `upload()` before `queue.accept` and re-marked with `PRIORITY.CUT` — cost if wrong: none.
