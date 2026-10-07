# Structural collapse (SP3b) — validation

Date: 2026-10-07. Selected desktop: Ryzen 5 5600 / RTX 5060 / Windows.

Status: **closed by user acceptance on 2026-10-07**. The user approved the current milestone and requested closure. Further collapse-pacing tuning and maximum simultaneous water/collapse browser stress are optional future follow-ups; they are not pending acceptance requirements for 3b. The measurement limits documented below remain unchanged.

## Delivered behavior

- `BlockDef.collapses` defaults to false. Existing IDs and material behavior remain intact, including sand/gravel's individual gravity. Appended sandbox types are `structural_planks` and `structural_glass`.
- Six-face connectivity reaches fixed normal solids or the finite world floor. Diagonal contact is not support. There is no local-radius or oversized-component stability approximation.
- A reusable numeric queue, sparse bitset pages, support certificates and structural invalidation drive bounded support checks. Water mirror and voxel-state changes do not restart topology checks. Initial generation seeds members directly rather than rescanning whole chunks each tick.
- Connected fragments retain voxel IDs/state bits, collide through all downward vertical runs and coexist with falling sand. Dynamic occupancy protects their footprint from edits/regeneration. Fragment membership is published once; exposed-face geometry is built once and frame work updates its transform.
- Source mesh barriers and every landing chunk/version coordinate handoff. Neighbor barriers advance versions without materializing uniform chunks. Cutout/translucent material handling is separate from opaque rendering.
- Final defaults: **4,096 visited cells per tick, 128 grid writes per tick, 128 cells per fragment, 64 moving fragments**. Landings and detachments share the write budget. Capacity pressure leaves pending cells in the grid; it does not delete bodies or lose voxels.
- `?scene=collapse` provides a bridge with two supports, a tower with a removable plinth, a normal beam and four buttons. The structural hotbar variants are available only in this demonstration's hotbar; normal palette entries remain available elsewhere.

## Quality checks

The workspace suite passed **1,113 tests**, with the same **2 expected water tile-cap failures**, across 118 test files. Workspace typecheck and production build passed. The existing approximately 1.2 MB main-bundle warning remains.

New tests exercise alternate supports, cross-chunk paths, diagonal contact, restoration during a partial search, strict visit/write caps, capacity pressure, idle, pause/resume, publication lifetime, reservations, payload state, arch/internal-gap contacts, falling sand, bulk regeneration, water conservation and deterministic replay. A simple complete-component oracle independently checks 20 randomized mixed worlds. Geometry tests inspect winding/materials, and track tests require both chunks in source/landing handoffs.

Functional Chrome validation passed **20 distinct tests**: the complete 19-test suite (collapse plus existing water/editor/general scenes), followed by an additional forced-WebGL2 test that renders a connected opaque/glass fragment and verifies both landed cells. Seven opt-in tests were skipped in the full functional run (brush benchmark, two collapse benchmarks, three water benchmarks and slow flood flattening). The two collapse performance checks were then run separately and both passed, for **22 passing browser checks** in total. Final affected engine suites also passed 44 tests after the cap/error-path tuning.

Screenshots of the moving deck and landed structures were inspected. Local copies are under `test-results/collapse-quality/` (ignored by Git). The moving deck has one connected fragment and fewer indices than one full cube per voxel; the normal beam remains suspended after its support is removed. The tower retains all 756 structural cells after its plinth is removed.

## Production browser acceptance

Two independent headed installed-Chrome runs, production bundle, WebGPU, 1280 × 720 and DPR 1. Each peak lasts from cutting the support of a 9,216-cell slab until physics reaches idle; it excludes shader warmup. These are **complete activity windows of about 8.7 seconds**, not the water benchmark's 90-second windows diluted with idle time. Frame rate is calculated from animation-frame intervals.

| Window | Tick p95 | Tick max | FPS p5 | Minimum FPS | Moving fragments, peak | Result |
|---|---:|---:|---:|---:|---:|---|
| 1: 174 ticks / 1,566 frames | 6.47 ms | 10.645 ms | 179.05 | 102.46 | 38 | Pass |
| 2: 173 ticks / 1,555 frames | 7.71 ms | 11.21 ms | 179.05 | 101.21 | 38 | Pass |

The gate is **tick p95 ≤ 10 ms and FPS p5 ≥ 45**; it is not a maximum-tick guarantee. Both runs observed moving rendered fragments on approximately 1,500 frames, rather than certifying a visually frozen source. Maximum visited/write counts stayed at 4,096/128, with no browser errors.

The initial 256-write production runs had tick p95 10.54/13.185 ms while keeping FPS p5 around 179. The dry Node prototype lacked water types; the real sandbox still maintains water-column topology for dry edits. Reducing the mutation/fragment default to 128 addressed the full integration cost, and the final Node probe also enables the water subsystem.

Recorded summary: [browser JSON](../research/2026-10-07-collapse-browser-results.json). Full Playwright JSON and the initial failed tuning run are retained locally under `test-results/collapse-quality/`.

## Complete Node CPU probes

These include collapse, water bookkeeping, lighting, commit and publication. They do not include workers/transport, meshing or rendering. World 256 × 96 × 256, water configured but dry, normal floor and a single removable support. Both large probes preserve all **36,864** structural cells and eventually reach idle under the caps.

| Case | Tick p95 | Tick max | First fragment tick | Settled tick |
|---|---:|---:|---:|---:|
| 16 × 16 deck, 256 cells | 4.670 ms | 10.053 ms | 0 | 31 |
| 96 × 96 × 4 slab | 3.727 ms | 5.816 ms | 9 | 745 |
| 192 × 192 × 1 slab | 6.242 ms | 10.459 ms | 9 | 599 |

At 20 Hz, the two large staged collapses take approximately 37/30 seconds to complete. The write cap pays for both leaving and returning to the grid; larger caller-selected caps shorten this at a measured CPU cost. Typed-queue growth and lighting can still create occasional spikes. An exact region index and greedy fragment meshing remain profiling-driven optimization candidates; neither is required for the measured acceptance cases.

The thick-slab probe initially exposed a detach/land/recheck loop: partial bodies rested on unprocessed grid members. Base-first, downward-closed partial selection fixes that case, and a smaller multi-layer regression test keeps it covered. An entire connected remainder that fits the budget still detaches as one shape.

Recorded data: [Node JSON](../research/2026-10-07-collapse-engine-results.json).

## Active-water integration

A 600-tick replay of the real flood generator breaches the dam while detaching a 1,600-cell structural slab over the valley. Water volume is exact **on every tick**, consistency checks are empty, all structural work finishes, and the water mirror causes **zero structural restarts**. The run reaches 15 moving fragments and 121 active water tiles; total tick p95 is 3.509 ms, maximum 12.717 ms.

The normal-block reference run has tick p95 4.837 ms. Run order/JIT warmup and different resulting world geometry prevent interpreting that difference as a percentage speedup. Recorded data: [water replay JSON](../research/2026-10-07-collapse-water-results.json).

This Node replay verifies simultaneous physics. The browser acceptance above uses a dry slab; a simultaneous maximum water stress plus a maximum collapse/rendering stress, a laptop and very large fragmented worlds remain unmeasured. Vertical translation preserves fragment shapes; rotation, material strength, impact fracture, buoyancy and continuous in-flight water displacement are outside this milestone.

## Repeat

From the root:

```powershell
npm test
npm run typecheck
npm run build -w @elovox/sandbox
$env:BENCH_ASSERT = '1'
node packages/engine/bench/collapse.node.ts
node apps/sandbox/bench/collapseWater.node.ts
```

From `apps/sandbox`, after building:

```powershell
$env:E2E_PORT = '5196'
$env:E2E_CHANNEL = 'chrome'
$env:E2E_PREVIEW = '1'
$env:BENCH_COLLAPSE = '1'
$env:BENCH_ASSERT = '1'
node ../../node_modules/@playwright/test/cli.js test e2e/collapse-bench.spec.ts --headed --workers=1
```

For functional browser tests, unset `E2E_PREVIEW`, `BENCH_COLLAPSE` and `BENCH_ASSERT`, then run `node ../../node_modules/@playwright/test/cli.js test --workers=1 --timeout=300000`. In a restrictive Windows sandbox, Vitest may require process-local `TEMP`/`TMP` under the writable `node_modules/.cache`; Vite's filesystem realpath and browser/server startup may require the permitted unsandboxed runner.
