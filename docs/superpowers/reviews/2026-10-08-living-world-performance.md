# Living-world performance (4a): final report

Date: 2026-10-08. Branch `feat/living-perf`, from `main` a612126.

- [Spec](../specs/2026-10-08-living-world-performance-design.md)
- [Plan, with every result and both addenda](../plans/2026-10-08-living-world-performance.md)
- Data, all in `../research/`: `2026-10-08-living-baseline.json`, `-living-after-1.json`, `-living-after-3.json`, `-batching-ab.json`

The user closed 4a after candidates #1 and #3. The final whole-branch review found the branch ready to merge, with minor findings only. The targets are not all met; what remains open is listed at the end.

## What was delivered

- **`?scene=living`**: a 512 × 512 × 128 terrain with four plateaus. On them stand a reservoir with a breakable dam, a structural tower that collapses, and a work site where 50 units dig a tunnel, build a bridge and a wall, and dig and refill a quarry for as long as the scene runs. The HUD has a button for each event.
- **Benchmark** (`BENCH_LIVING=1`, `e2e/living-bench.spec.ts`), with six windows: idle and work at the default and far cameras, the dam, and the collapse.
  - Each event fires inside its window.
  - Both runs are merged by taking the worst value of every metric.
  - The run fails when a window is throttled, has no collapse fragments, or has less than one active unit on average.
  - Supporting tools: `bench/living.node.ts` (sim ticks in Node, for `--cpu-prof`) and `bench/topSelf.node.mjs` (top self time of a profile).
- **#1, cheaper layered water apply.** In tiles that hold water layers, the columns with no slot in their 3 × 3 take the fast path again. That is over 95% of them.
- **#3, chunks drawn in region batches.** Opaque and cutout chunk layers are drawn by one `BatchedMesh` per layer per 4 × 4-chunk region. `EngineOptions.batchChunks` defaults to true; `?nobatch` turns it off.

## Results

Worst of two runs per phase, in milliseconds. Each column comes from a separate session, so these numbers gate the targets but do not attribute gains. Attribution comes from the interleaved A/B tests below.

| Phase | fps p5: baseline → #1 → #3 | CPU frame median: baseline → #3 | Water apply p95: baseline → #1 |
|---|---|---|---|
| idle-default | 30.0 → 36.0 → 44.9 | 13.6 → 11.4 | 15.3 → 6.0 |
| idle-far | 22.5 → 25.7 → 44.9 | 20.1 → 13.3 | 14.6 → 5.9 |
| work-default | 29.9 → 36.0 → 44.9 | 14.6 → 11.6 | 16.0 → 6.5 |
| work-far | 20.0 → 22.5 → 36.0 | 20.5 → 13.5 | 16.0 → 7.4 |
| dam | 10.6 → 15.0 → 16.4 | 22.2 → 16.6 | 38.0 → 21.8 |
| collapse | 7.8 → 20.0 → 16.4 | 22.1 → 16.7 | 47.9 → 21.3 |

**Attribution.** Each A/B ran in one Edge session with alternating order.

- **#1:** water apply drops by more than half, and the CPU per frame does not change. An earlier A/B with a fixed order showed a rise that was only session drift.
- **#3:** CPU per frame drops to about a third. It is 9.7–12.8 ms with batches against 26.5–45.1 ms without, at the default and far cameras. In the dam and collapse phases it is 12–14 ms against 31–40 ms. Shadow render objects fall from 715 to 31, and the sim tick and water apply are equal with and without batches.

**Tick and water apply in the last benchmark.** Both are higher after #3, but the dam/collapse A/B attributes that to machine state (low free memory during that session), not to batching.

**Same picture.** `e2e/batching.spec.ts` renders batched and unbatched on WebGPU and WebGL2, over a multi-region terrain with trees: 0.06–0.10% of pixels differ, against a 0.5% limit.

## Process notes

- **Phase 1:** the final review caught a benchmark that did not measure what it claimed. The collapse fired outside its window, the work ended in 30 s, and throttled windows went unflagged. The benchmark was fixed and the baseline re-recorded before phase 2.
- **#1:** the task review found a visible transition bug: water swept up from 0 when a ceiling over it was removed. It was fixed with a differential test that covers slots appearing and disappearing.
- **#3:** the task review found two Critical bugs that the first tests missed:
  - compaction corrupted geometry, because the `packed`/`position` alias was copied twice;
  - WebGL2 placed every chunk of a batch at one offset.

  Both were fixed test-first.
- **Rule adopted for attribution:** compare builds interleaved in alternating order within one session.

## Still open

- **Targets not met.**
  - fps p5 is about 36–45 in the idle and work phases and about 16–25 in the dam and collapse phases; the target is ≥ 60.
  - Water apply p95 is 6–10 ms idle and 22–33 ms in the dam and collapse phases; the target is ≤ 4 ms.
  - Sim tick p95 is over 10 ms in the dam and collapse phases.
- **Candidates not done.**
  - #5, cheaper water publish in the sim, for the tick.
  - #4, shadow casters only near the camera. Batching cut shadow render objects to 31, but the shadow pass still draws every chunk's range: only the per-object CPU cost dropped, so #4's GPU saving still stands.
  - #2, water apply in a worker.
  - #6, fewer animated unit models.
- **Batching follow-ups.**
  - Initial batch capacity is about 28 MiB on both the CPU and GPU side in the 512² living world (31 batches). The default 1024² world can reach about 112 MiB each (128 batches), about half of it in mostly empty cutout batches. Size cutout batches smaller.
  - `EngineStats.shadowCasters` now counts render objects (batches plus meshes), not chunk meshes, and needs a doc comment.
  - Each batch build logs a harmless `THREE.TSL: Vertex attribute "normal" not found` warning, about 128 at load in the 1024² world.
  - `ChunkBatches.setMaterial` is unused.
  - Old GPU buffers after a grow are freed only by GC.
  - `PassGuard` has no recovery if a render throws.
  - The batches depend on three r186 private fields. A test fails on any three upgrade so they get re-checked.
- **Benchmark caveats.** Absolute numbers depend on machine state such as free memory and background apps. Gate runs should be done on a quiet machine.
