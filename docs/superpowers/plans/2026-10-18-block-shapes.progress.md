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
