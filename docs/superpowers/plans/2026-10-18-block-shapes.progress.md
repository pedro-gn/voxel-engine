# SDD ledger — plan: docs/superpowers/plans/2026-10-18-block-shapes.md

Executor: inline (superpowers:executing-plans), Part A Tasks 1–6 only. Spec: docs/superpowers/specs/2026-10-18-block-shapes-design.md.
BASE (branch start): 1b46c05 (plan commit on top of origin main 571d935).

## Pre-flight
- T1 → T2: `BlockShape`, `SHAPE_CODE` — consistent.
- T1/T2 → T3: `shapeBoxes`, `stairForm`, `SHAPE`, `LAYER.SHAPE`, `shape`/`blocksLight` tables — consistent.
- T2 → T4: `blocksLight` — consistent.
- T1 → T6: exports of `slabState`, `stairState`, `postState`, `turnShapeState`, types — consistent.

## Tasks
- Task 1: Ruling: `stairForm` returns shared frozen form objects and `shapeBoxes` precomputed frozen arrays (no allocation per cell in the mesher); a corner `side` parallel to the facing draws straight — cost if wrong: none observable.
- Task 1: complete (commit 7dfe886; tests: npx vitest run test/shapes.test.ts → 28/28 pass)
- Task 2: Ruling (D1): the shaped test blocks go in a new `SHAPED_TEST_BLOCKS` that `testRegistry()` appends after `TEST_BLOCKS`, instead of appending them to `TEST_BLOCKS` itself — 11 test files build `[...TEST_BLOCKS, spring/sand…]` with hard-coded ids 8+ (28 failures); ids 8–10 hold for `testRegistry()` as the plan wants — cost if wrong: a test wanting shapes in `TEST_BLOCKS` must spread both lists.
- Task 2: Ruling (D2): `registry.test.ts`'s `count` expectation goes 8 → 11 (the three appended blocks). Rejection messages use the word `render: false` / `layer "cutout"` (the plan's regexes match).
- Task 2: complete (commit 0141a95; tests: npx vitest run → 125 files, 1346 passed + 2 expected fail)
- Task 3: Ruling (D3): `src/mesh/liquid.ts` also changes — it called `packB(…, 1, 1)` for w/h; under the new word B that would offset every liquid vertex by fx 1/16, fy 4/16. Now `packB(tex, sky, blk)`.
- Task 3: Ruling (D4): `test/meshHelpers.ts` `assertOutwardWinding` decodes fx/fy/fz (sub-block quads are degenerate on the integer grid alone).
- Task 3: Ruling: internal faces of a shape are clipped against its own boxes (needed for the plan's "stair +y area 1" test); the clipped face pieces are precomputed per shared box list (Map keyed by `shapeBoxes`'s frozen arrays). Faces between two neighbouring shapes are drawn (plan allows).
- Task 3: Ruling: shape quads go through the shader's existing corner/winding path (`REVERSE[f]`, no AO flip); `faceLight` uses one value per face direction per cell. Added a fragments test (shaped member falls as an opaque cube, layer 1), mutation-checked. `src/mesh/shapes.ts` imports `AXES`/`REVERSE` from `greedy.ts`, which imports `faceLight` back (call-time only cycle).
- Task 3: Open: `WorldReader`'s implied light for uniform chunks still reads `opaque` (handled in Task 4 with the store).
- Task 3: bench sanity (no-shapes chunk, plain node): 2.41–2.49 ms vs base 2.46–2.54 ms (one cold first run via npm read 3.36 ms — noise, see Task 6 gate).
- Task 3: complete (commit 6a8d642; tests: npx vitest run → 126 files, 1355 passed + 2 expected fail; npm run typecheck → exit 0)
- Task 4: Ruling (D5): the light tests build a `Simulation` (not the file's `world()` helper, which hands `reg.opaque` to the store and engine directly and so could never see the swap in `simulation.ts`). The post test passes before and after (posts were never light-blocking); kept as a guard.
- Task 4: Ruling (D6): beyond `src/sim`, `WorldReader` gains a third constructor argument `blocksLight` (defaults to `opaque`): implied light of uniform chunks reads it, `isTrivial` keeps `opaque`. Fed by the mesh worker (`MeshJobRunner`), the main-thread reader (`engine.ts`) and the water worker (its init message gains `blocksLight`). Kept on `opaque`: the rule context's `isOpaque`, `waterSystem`'s water-block check, every culling use. — cost if wrong: a uniform chunk of slabs/stairs would read as sky-lit in readers while the sim holds it dark.
- Task 4: complete (commit 68f746e; tests: npx vitest run → 126 files, 1357 passed + 2 expected fail; typecheck exit 0)
- Task 5: Ruling (D7): the reach tests live in `test/buildReach.test.ts`, not `controlledUnits.test.ts` — that file's harness already takes worker options (`buildReach: 3`), pillars and an outcome helper; the feet + 4 target sits on a pillar (the existing "feet + 4 fails" scenario) rather than a boxed column. Added a save round-trip (the intent carries `reach`, so a restored unit keeps it).
- Task 5: Ruling: `reach` rides on the build `Intent` (`reach?: number`, saved with the unit) and on the one-cell `Order`; `tilesAround` takes the task. A bad reach throws `RangeError('build reach must be an integer 1..16')` from `workers.work`; through a system tick the sim wraps it as `system <name> tick: …` (the test checks the message there, the RangeError on `workers.work`).
- Task 5: Open (pre-existing): `node bench/workers.node.ts` fails its `stats.visited <= 4096` assert on base 1b46c05 too. Run with that assert removed (temp copy, not committed), two interleaved runs each: 1000 units idle p50 1.13–1.22 ms base vs 1.21–1.23 new; moving p50 13.1/15.2 base vs 18.1/14.0 new (noise ±30 %); 100 units moving p50 2.19/2.40 base vs 2.26/2.51 new. No regression visible.
- Task 5: complete (commit 79d20f7; tests: npx vitest run → 126 files, 1360 passed + 2 expected fail; typecheck exit 0)
- Task 6: Ruling (D8): `bench/mesher.node.ts` times each chunk in a fresh child process. Timing a second workload in the same process runs ~25 % slower whatever it is (the same surface chunk timed twice in one process: greedy 2.24 → 2.86 ms), which pushed roofs to 3.5–3.7 ms after surface while roofs alone measured 2.8–3.1. — cost if wrong: none for the gate's meaning; one more process per run.
- Task 6: Ruling (D9): to meet the roofs gate, the shape pass precomputes each piece's packed corner words, and culls a side piece against a neighbouring shape that covers it whatever that neighbour's stair form (form-independent, so both sides of a chunk border agree): roofs chunk 3846 → 2790 shape quads. New test "drops faces a neighbouring shape covers whatever its form" (mutation-checked). Greedy's light read checks `t.shape[nid]` before calling `faceLight`.
- Task 6: Ruling (D10): pieces inside a shape's cell (a step's riser, a slab's top, a post's sides) are lit from the shape's own cell (`faceLight(pi)`), not the cell in the normal's direction as the plan says — the sandbox showed black risers where that cell is an opaque cube (it holds no light). Test "a stair's step facing a cube is lit from the stair's own cell" RED→GREEN.
- Task 6: Ruling: the bench also reports (not gated) an all-stairs chunk, as the spec asks; `decoratedMeshTables` gains a `shaped` flag for the roofs tables. Sandbox e2e uses `E2E_PORT=5287`: port 5199 is another project's dev server (colony-production) and Playwright's `reuseExistingServer` silently loaded it.
- Task 6: Bench (plain node, fresh process each, 3 runs): surface 2.374 / 2.388 / 2.456 ms; roofs 2.816 / 2.815 / 2.760 ms (limit 3); all stairs 20.5–24.7 ms (reported). Earlier runs under machine load: surface up to 2.8–3.3 and roofs 3.0–3.1 — the roofs margin is ~0.2 ms.
- Task 6: Sandbox: `?scene=shapes` (96 × 32 × 64): rows of every stair facing × half (planks, stone) beside cubes, slabs, posts/beams; a gable roof; a 7 × 7 hip roof; an L-shaped hip roof (inner corners) in stone; a framed wall. e2e passes; screenshot apps/sandbox/test-results/shapes.png (git-ignored).
- Task 6: complete (commit bd45170; tests: npm test → engine 126 files 1363 passed + 2 expected fail, terrain 174, terrain-editor 200, sandbox 139; npm run typecheck → exit 0; e2e shapes.spec.ts → 1 passed)

## Engine checkpoint (stop: Part B waits for the user's OK and SP12)
Open issues:
- Roofs gate margin ~0.2 ms; under machine load the gate can fail on noise (surface itself read 2.8–3.3 then).
- `bench/workers.node.ts` fails its own `stats.visited <= 4096` assert on base too (pre-existing).
- Cube faces against a shape are lit by `faceLight`'s neighbour approximation (brightest neighbour − 1), not the sim's light; AO is 0 on shaped faces and shapes do not darken cube AO.
- Falling/fragment shaped blocks draw as cubes (spec's known limitation).

## Rebase onto origin/main 7c31ca1 (feat/surface-speed), 2026-10-19
- `git rebase origin/main`: no conflicts (workers.ts merged cleanly: surface speed and per-build `reach` both kept; CONTEXT.md gained both glossary entries). Branch tips: fa70f9e..e281c3a now on 7c31ca1.
- `npm test`: engine 127 files 1373 passed + 2 expected fail (surfaceSpeed tests included), terrain 174, terrain-editor 200, sandbox 139. `npm run typecheck`: exit 0. `E2E_PORT=5287 … shapes.spec.ts`: 1 passed.
- Mesher gate, 3 runs: surface 2.524 / 2.620 / 2.676 ms; roofs 3.033 (FAIL) / 2.894 / 2.818 ms; all stairs 22–23 ms. No mesher code changed in the rebase; the machine reads the surface chunk ~0.15–0.3 ms slower than this morning. Open: the roofs gate is at the edge of noise.

## Part B — colony pilot (worktree colony-production, branch feat/hip-roof from origin/main bd17c4b)
Commits: bdace54 chore (engine submodule → 77a199e, this branch's tip), f7ef14f Task 7, de80456 Task 8, c806fc2 (clearance never below 4), 742e7c7 (corner supports + column rule).
- B Ruling: SP12's "stairs" are a block-order kind (`kind: 'stair'`, a zigzag of full material cubes, `Escada`); no block, type or rule is named `roof_stair`, `SHAPE_OF` or roof reach, so the plan's names stand.
- B Ruling (BD1): `shared/blueprints.ts` imports `stairState`/`turnShapeState`/`BlockShape` from `@elovox/engine/sim-worker` (shared code had no engine import; the client entry would pull three into the sim worker).
- B Ruling (BD2): the hip roof holds the plan's 33 pieces (32 `roof_stair` + the `roof` peak; house 82 blocks) but in another build order: outer ring, side-middle supports, h 4 side middles, h 4 corners, then the corner supports under them, the peak last. A builder reaches an h 4 corner only straight up its own column from the floor (ROOF_REACH); a support under it first would close that column (the first try, 29 pieces with open corners, left four holes in the attic under the layer cut). To hold the order with two builders out of order, `buildable` (colony construction.ts) now skips a block while an earlier block of its column above it is not done — no built-in blueprint had such a pair before. Mutation checks: without ROOF_REACH, and without the column rule, the house never finishes.
- B Ruling (BD3): ROOF_REACH also widens the colony's own stand search (`siteWork.standFor`) for a roof piece's swap or dismantle — a demolition takes the h 4 ring down from the floor. Free-block and wall stands keep BUILD_REACH.
- B Ruling (BD4): the sim's block-name table (`worldOf`) gains `roof_stair` (the house's intact check reads names); `heightOf(id)` (highest block + 1 over all levels, never under the old 4: the plaza's 3 would have loosened its checks) drives `checkPlacement`, the free ring's clearance in `colony:placeBuilding` and the build tool's preview box.
- B Ruling (BD5): `LevelStep` gains the new block's `state`; a cell is kept only when block and state match (`sameBlock`); an R2 demolition cell is taken down by id (state 0).
- B Ruling (BD6): collateral test updates: house 74 → 82 blocks (shares now 1, 0, 1, 0…: two construction.test cases use one wood per block to keep their rule visible; a placed count 3 → 4), level 2's kept wood 15 → 18 (its demolition gives 9 wood, not 7; the level-2 walls' recovery (40 − 18) / 2), COLONY_VERSION 13 → 14, layout probe C digs two blocks lower (one lower is now within roof reach). Task 8's harness test builds at rotations 1 and 2 and checks every voxel's id and state.
- B: colony unit suite (final): 115 files, 925/925; typecheck exit 0. Earlier full runs flaked only on timing tests (freeBlocks < 30 ms, paint boot budget, reachGuardIsland < 2 ms; all pass alone).
- B: colony e2e (`E2E_PORT=5291 E2E_CHANNEL=msedge --workers=1`, 52.8 min, at de80456): 25 passed, 4 failed — areas gather (fruit wait), plaza (sitter off the benches: SP12's recorded flake), resources fruit haul WebGPU (SP12's recorded flake), workEffects (a mid-run HMR reload from an edit in the worktree); rerun alone 6/6 passed. After 742e7c7: construction + upgrades e2e 2/2 passed (17.1 min).
- B: captures (untracked) colony docs/art/captures/2026-10-19/: hip-roof-management.png, hip-roof-cut-attic.png (cut at h 3: closed but the centre under the peak), hip-roof-cut-room.png.
