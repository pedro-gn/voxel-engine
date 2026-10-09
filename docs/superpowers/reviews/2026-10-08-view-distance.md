# View distance (4b): final report

Date: 2026-10-09. Branch `feat/view-distance`, from `main` 90e5c97.

- [Spec](../specs/2026-10-08-view-distance-design.md)
- [Plan](../plans/2026-10-08-view-distance.md)
- Data, all in `../research/`:
  - baseline: `2026-10-08-view-baseline/`
  - A/Bs: `2026-10-08-view-ab-cull.json`, `-ab-region.json`, `-ab-region-2.json`, `-ab-deco.json`
  - gates: `2026-10-08-view-gate-part1.json`, `-gate-part1-2.json`, `-gate-part1-3.json`
  - picture diff: `2026-10-08-view-picture-vs-main.json`
  - R sweep: `2026-10-08-view-sweep.json`
  - living A/B: `2026-10-08-view-living-ab.json`
  - screenshots: `2026-10-08-view-checkpoint/`

## What was delivered

**Part 1: CPU cuts with the same picture.**
- **The engine's own batch cull** (`render/chunkCull.ts`, `chunkBatches.ts`). Each pass runs a world-space frustum test over
  precomputed chunk spheres, plus the view distance, with no sort. It replaces three's per-instance cull and sort in the
  camera pass and the shadow pass. Three's cull stays available as `?cull=three` (`EngineOptions.threeCull`,
  `@internal`), the pixel-diff reference.
- **Hidden decorations leave the scene graph** (`render/decorations/decorationMeshes.ts`). Hidden meshes are detached
  instead of kept invisible. The selection is redone only after the camera moves 2 blocks or the entries change. Scene
  objects drop from 3028 to 230 (world) and from 2093 to 477 (terrain).
- **Region batches of 8 × 8 chunk columns** (`REGION = 8`, was 4). Adopted after a re-A/B that measured edit latency in
  wall ms. `?region=` (`EngineOptions.regionChunks`, `@internal`) keeps the A/B possible.
- **Smaller cutout batches.** The cutout layer starts at 512 vertices per slot. The measured average at 1024² is 278.
- **`EngineStats.batchBytes`**: bytes the region batches reserve.

**Part 2: `Quality.viewDistance`** (default `Infinity`, finite range [64, 4096]).
- Beyond R, in both passes, the renderer skips chunks, whole region batches, unbatched meshes, water surfaces (the one
  `waterSurface.ts` hook) and decorations. Shadow reach is clamped to R.
- `camera.far` follows R (R + 64, or 3000 at `Infinity`).
- The edge: a height-independent fog term `smoothstep(0.75R, R, d)`, max'ed with the fog factor. With fog off there is an
  edge-only fog node. At `Infinity` there is no node change at all.
- Sandbox: `?view=` and a view-distance field. `EngineStats.chunksDrawn` counts the chunks drawn.

**Batching follow-ups from the 4a review.**
- The `normal` alias silences three's per-batch warning at its source.
- `setMaterial` is removed.
- Buffers replaced by a grow are freed through the renderer's attribute store. This relies on a three private, pinned in
  `chunkBatches.test.ts`.
- `PassGuard.reset` runs every frame.
- `shadowCasters` is documented.

**Tooling.**
- `bench/viewAB.mjs`: interleaved A/B of prebuilt bundles, with the bundle SHAs recorded.
- View-bench probes:
  - edit latency in frames and in wall ms;
  - edit max CPU;
  - batch memory;
  - per-layer batch use.
- `e2e/compare-shots.spec.ts`: picture diff of two bundles.
- `e2e/shots.ts`: shared shot and diff helpers.

**Docs.**
- `CONTEXT.md`: **View distance**.

## Measurements

All windows were expert-granted, on a quiet machine: no game; Steam was idle; free RAM was 14.6–16.3 GB. Edge was
headed, on port 5181, with production bundles. The display runs at 180 Hz, so fps p5 is quantized to 180 / 90 / 60. A
frame whose CPU passes about 11 ms waits three vsyncs.

### Part-1 A/Bs (CPU median ms, larger of two interleaved runs; GPU flat unless noted)

| Item | Scene | default | far | far-low | ground | Verdict |
|---|---|---|---|---|---|---|
| Own cull vs three's | world | 1.57 / 2.11 | 2.52 / 3.50 | 2.28 / 3.23 | 2.20 / 3.27 | keep (ground GPU 1.34 / 1.40) |
| | terrain | 3.43 / 3.70 | 6.75 / 6.93 | 6.90 / 7.56 | 6.13 / 6.35 | (ground GPU 1.28 / 1.29) |
| Decoration detach vs before | world | 1.81 / 3.71 | 2.44 / 4.51 | 2.31 / 5.04 | 2.47 / 4.74 | keep |
| | terrain | 3.98 / 4.36 | 8.34 / 10.57 | 8.31 / 10.17 | 6.58 / 7.98 | |
| Region 8 vs 4 (re-A/B) | world | 1.79 / 1.86 | 1.66 / 3.22 | 1.54 / 2.65 | 1.55 / 2.54 | keep |
| | terrain | 2.66 / 3.67 | 5.53 / 7.68 | 5.29 / 7.57 | 5.41 / 7.12 | |

Region 8 had a keep rule of its own: edit latency no worse, edit CPU within 10%, and memory up to +10%.
- The first A/B counted edit latency in frames, and region 8 looked worse on terrain (median 7.5 vs 5 frames).
- Diagnosis:
  - three r186 uploads only the update ranges of an edit;
  - region 8's main-thread apply is cheaper (micro-bench: in place 0.09 vs 0.37 ms);
  - region 4's long frames hide its wait in fewer frames.
- The expert ruled that wall ms decides. In the re-A/B (worse run), r8 / r4:

| | editMs median | editMs max | editMaxCpu | batchBytes |
|---|---|---|---|---|
| world | 42.8 / 45.4 | 56.5 / 68.8 | 5.53 / 7.86 | 80.7 / 74.8 MB (+8%) |
| terrain | 44.9 / 67.6 | 50.2 / 116.7 | 15.97 / 29.46 | 101.8 / 98.4 MB (+3.5%) |

### Part-1 gate (fps p5 ≥ 60, worse of two runs, default R)

**Met on the final bundle (c41f0ec, `-gate-part1-3.json`).** Values are worse fps p5 of two runs, with CPU median / CPU
p95 in ms:

| Scene | default | far | far-low | ground |
|---|---|---|---|---|
| world | 178.41 (1.71 / 2.85) | 178.57 (1.94 / 3.09) | 177.94 (1.74 / 2.95) | 178.25 (1.65 / 3.04) |
| terrain | 178.41 (2.81 / 4.59) | 177.46 (3.60 / 6.21) | 177.15 (3.71 / 6.81) | 176.37 (3.78 / 5.96) |

On `main`, the baseline was terrain ground 59.8 and orbit 400 60.0. Two earlier gates missed:
- With region 4 (the deco window's head slots, then a dedicated hh run), terrain far / far-low sat at 59.9–60.0. CPU p95
  was 9–13.8 ms there, across the three-vsync line.
- Region 8 brought terrain CPU p95 to at most 6.8 ms.

### Same picture as `main` (default R)

Main 90e5c97 bundle vs branch c41f0ec bundle, at the view-bench poses in both 1024² scenes. Conditions: `?still`,
decorations off, clouds frozen, water hidden, WebGPU, tolerance 8 per channel. Camera matrices are bit-equal.

| Scene | default | far | far-low | ground |
|---|---|---|---|---|
| world | 0.0031% | 0.0003% | 0.0004% | 0% |
| terrain | 0.0007% | 0.0002% | 0.0005% | 0% |

The batching e2e at region 8 (1024² showcase):
- batched vs unbatched: 0.0150% on WebGPU, 0.0218% on WebGL2;
- own cull vs three's: 0–0.0002%.

### R sweep

Bundle c41f0ec, order i532235i (`-view-sweep.json`). CPU median ms at inf / 512 / 384 / 256:

| Scene | default | far | far-low | ground |
|---|---|---|---|---|
| world | 1.68 / 2.28 / 1.88 / 1.85 | 1.77 / 1.74 / 1.65 / 1.42 | 1.67 / 1.62 / 1.54 / 1.35 | 1.71 / 1.53 / 1.43 / 1.33 |
| terrain | 2.67 / 3.14 / 2.91 / 2.58 | 3.43 / 3.10 / 2.43 / 1.66 | 3.37 / 2.97 / 2.33 / 1.86 | 3.58 / 2.58 / 2.12 / 1.86 |

- Draws at terrain far: 4334 / 1752 / 725 / 14. GPU ms there: 1.83 / 1.24 / 1.05 / 0.61.
- At the default orbit, a finite R hides almost nothing and costs 0.2–0.6 ms, from the per-batch range check and the edge
  fog node.
- Every slot keeps fps p5 ≥ 177, except one world 512 slot. That slot read about 89.5 at every pose, including the
  default, where R changes nothing, with CPU p95 under 4 ms. It is frame-pacing jitter in that browser session; the other
  world 512 slot read 178.6–178.9.

### Living benchmark, `main` vs branch (exit condition)

**Met: no regression; the branch is better in every phase** (`-view-living-ab.json`). Setup: main 90e5c97 vs c41f0ec,
order m f f m, each slot one living-bench invocation of 2 runs.

Worst of 4 runs, as CPU median ms / fps median / fps p5:

| Phase | branch | main |
|---|---|---|
| idle-default | 3.31 / 180.0 / 178.4 | 6.33 / 179.2 / 60.0 |
| idle-far | 3.81 / 179.9 / 177.6 | 8.02 / 90.2 / 59.8 |
| work-default | 3.69 / 179.9 / 177.2 | 6.31 / 177.9 / 60.0 |
| work-far | 4.00 / 179.9 / 90.3 | 6.77 / 178.6 / 60.0 |
| dam | 5.32 / 179.5 / 36.1 | 8.05 / 90.1 / 30.0 |
| collapse | 6.25 / 179.1 / 36.0 | 9.22 / 89.9 / 25.7 |

- Tick p95 and apply p95 (perf's paths, which 4b does not touch) are equal or better.
- No run is invalid.
- The dam and collapse fps p5 stay below 60 on both sides. They are bound by perf's water apply and sim tick, which are
  4a round 2's subjects.

## Screenshots (checkpoint 1)

`../research/2026-10-08-view-checkpoint/<pose>-<preset>-<inf|384|256>.jpg`:
- poses: ground (target 120, 120; pitch 0.15; distance 8) and orbit 400 at pitch 0.3;
- presets: open, sunset and diorama.

The edge dissolves into the sky colour in every preset, with no hard cut and no shadow seam. At orbit 400, a view
distance of 256 or 384 is shorter than the camera distance, so even the orbit target fogs out: R is measured from the
camera.

At the ground pose the camera sits in the snowy mountain's cross-section, with floating slabs and see-through walls. That
picture is identical on `main` (0 px diff), so it comes from the pose, not from 4b. The shots went to the user through the
expert, with the recommendation to keep the default at `Infinity`.

The sandbox view field now follows an R set through the API (5f15674). In the shots it still reads ∞.

## Verification

At 5f15674:
- `npm run typecheck`: 0.
- `npm test`:
  - engine 816 passed + 2 expected fail (78 files);
  - terrain 174;
  - terrain-editor 200;
  - sandbox 104.
- Full sandbox e2e (Edge, port 5181, one worker): 33 passed, 13 skipped. The skips are the benches and the env-gated shot
  and compare specs. This covers batching, view-distance, smoke, living and water-render.

## Open items

1. **Checkpoint 2, the default R.** The default stays `Infinity`, pending the user's answer to checkpoint 1. The expert
   recommends `Infinity`: part 1 meets the gate without a finite R, and a finite R costs 0.2–0.6 ms at the default orbit.
2. **three r186 privates.** The cull and the grow release depend on three's private fields: `_geometryInfo`,
   `_instanceInfo`, the multi-draw arrays, `_indirectTexture` and the renderer's `_attributes`. Their internals tests in
   `chunkBatches.test.ts` must be re-checked on every three upgrade.
3. **Merge with perf (4a round 2).** Merge lod last. Re-check its `waterSurface.ts` hook (`setRange`) against perf's
   `SurfaceSource` type change. Re-check the visuals.ts shadow and decoration lines against perf's type-only edit there.
4. **The 180 Hz display quantizes fps p5** to 180 / 90 / 60. Gates near 60 depend on CPU p95 against the 11.1 ms
   three-vsync line. This is a property of the bench machine, recorded so later gates read it the same way.
5. **`?region=` and `?cull=three` stay** as `@internal` debug options. The batching e2e uses `?cull=three` as its
   reference.
