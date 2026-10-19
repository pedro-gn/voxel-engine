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
