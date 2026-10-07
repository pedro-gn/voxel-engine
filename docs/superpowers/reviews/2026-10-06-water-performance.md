# Water quality and performance — 2026-10-06

## Target and method

The user selected the connected desktop as the target: **Ryzen 5 5600, NVIDIA RTX 5060, 32 GB RAM, Windows**. This supersedes the plan's pending laptop measurement for this review.

The installed Chrome 154 exposes the NVIDIA adapter through WebGPU. Bundled Chromium 153 in headless mode uses SwiftShader and has no WebGPU adapter; its FPS results are not hardware measurements. `E2E_CHANNEL=chrome` selects the hardware browser without changing CI defaults.

Final browser measurements use visible Chrome (`--headed`), the production build, a 1280 × 720 viewport at device pixel ratio 1, the default flood camera/effects, and two independent 90-second windows after initial meshes/rendering are ready. The flood scene is 256 × 64 × 256; the stationary reference terrain is 256 × 128 × 256. They record worker tick times, main-thread water apply times, FPS, and time to drainage. The optional `BENCH_ASSERT=1` gate checks WebGPU, tick p95 ≤ 10 ms and FPS p5 ≥ 45; the final minimum FPS also exceeded 45 in both windows.

## Quality checks

- Final full workspace suite: **1,093 passed, 2 expected failures**, in 116 passing test files.
- The expected failures already document deep water not settling when a low tile cap makes borders step out of phase (`waterColumns.test.ts`, caps 3 and 1). They are not new failures or fixed by these rendering/scheduling changes.
- Production build: **passed**. The existing bundle-size warning remains (about 1.2 MB before gzip, dominated by the rendering stack).
- Workspace typecheck: **passed**.
- New mesh retry tests reproduced immediate requeueing before the fix; the queue/mesh job/reader suite then passed **26 tests**.
- Surface/interpolation suites passed **81 tests**. A 400-tick flood replay matched every published surface/corner/light/curtain buffer against a frozen pre-optimization view and preserved total water volume exactly.
- **18 functional E2E passed** on accelerated Chrome, covering WebGPU, WebGL2 shadow contacts, water, general scenes and editor operations. Two readiness assumptions were fixed: corners under a low bridge join only once neighbouring water drops below its deck, and an editor screen pick waits for the terrain-following camera to finish damping.
- **3 performance/idle E2E passed**: the two peak windows and a stationary terrain lake with normal physics still active.

## Initial hardware measurements

These were diagnostic headless runs. The final acceptance protocol uses a visible browser as specified in the plan, so these rows are not a controlled percentage comparison with the final table.

| Scenario | Tick p95 | Water apply p95 | Worst rolling apply p95 | FPS p5 | Minimum FPS |
|---|---:|---:|---:|---:|---:|
| Dam break | 14.17 ms | 20.36 ms | 26.60 ms | 56.96 | 31.03 |
| Stress | 17.40 ms | 22.63 ms | 25.01 ms | 44.70 | 31.98 |

Both runs had no browser errors and reached the valley with water. Both missed the tick budget; the stress run also missed the FPS p5 budget.

## Diagnosis and changes

The browser CPU profile identified surface-column refresh and interpolation settling as significant costs. Interpolation now filters settled slots while their existing quad and offset are in hand, avoiding another lookup/scan over every refreshed slot. The frozen-view replay remained an exact match.

A separate 30-second stress probe counted **13,846 failed mesh snapshots** with six workers. Those failures were requeued immediately, allowing workers and the main thread to spin while simulation seqlocks were still open. Reducing the pool to three workers did not solve this (19,554 retries), so the pool size remains unchanged.

Snapshot retries now wait for the next animation frame. Their queue entry retains edits and the highest priority received meanwhile, and unrelated chunks can still dispatch immediately. Tests cover coalescing, priority, and cancelling an entry before the next frame. Immediate retries for actual worker errors retain their prior behavior.

The simulation mirror now reads only the changed surface band when its floor is unchanged, with full rewrites retained for edits. Columns with an unchanged quantized level skip the full mirror call. Common dense edges use a flat-bed acceleration path, interior columns avoid repeated boundary checks, and ordinary transfers avoid the ballistic-fall path. A separate 500-tick replay for both breach and stress matched the complete simulation hash against the old kernels. Constants, tile cap, physics order and integer rounding are unchanged.

## Final acceptance

| Scenario | Tick p95 | Water apply p95 | FPS p5 | Minimum FPS | Result |
|---|---:|---:|---:|---:|---|
| Dam break | **8.28 ms** | 12.56 ms | 116.83 | **101.97** | Pass |
| Stress | **8.99 ms** | 12.92 ms | 75.00 | **71.56** | Pass |

The valley was wet in approximately 0.5 seconds in each case. Both 90-second windows recorded over 1,800 ticks, no browser errors, and met the selected desktop's tick/FPS budgets. The water apply work did not need to be spread across frames because the measured frame-rate floor stayed above the target.

The gate is p95, not a maximum: the largest ticks were 19.55 ms (dam) and 59.07 ms (stress). Those occasional spikes remain visible in the raw reports.

The stationary check uses the terrain scene's real generator and reference document, with a flat base and only the lake op enabled. The normal showcase includes a spring-fed river and is continuously active; it is not a stationary-water case. After regeneration, the static lake reached **0 water tiles, 0 active columns/bodies, physicsBusy=false** while physics remained unpaused. Its water apply meters stayed unchanged over 40 more ticks. Those meters retain historical initialization/regeneration samples (including a 102 ms rolling p95); they do not represent ongoing idle work.

The standalone Node dam run completed 3,000 ticks with exact volume on every tick: tick p50 4.51 / p95 5.87 ms, water step p95 3.50 ms, mirror+publish p95 2.04 ms. Raw logs, JSON reports and CPU profiles are retained locally under `test-results/water-quality/` (ignored by Git). These measurements certify this desktop, not a different laptop.

## Repeat

From the repository root:

```powershell
npm test
npm run typecheck
npm run build -w @elovox/sandbox
```

From `apps/sandbox`, after building:

```powershell
$env:E2E_PORT = '5191'
$env:E2E_CHANNEL = 'chrome'
$env:E2E_PREVIEW = '1'
$env:BENCH = '1'
$env:BENCH_ASSERT = '1'
npx playwright test e2e/flood-bench.spec.ts --headed --workers=1 --reporter=json
```

For source-based functional E2E (including test fixtures), unset `BENCH` and `E2E_PREVIEW`, keep `E2E_CHANNEL=chrome`, and run `npx playwright test --workers=1`. The optional 21-minute `E2E_SLOW=1` flood flattening test remains separate from the peak-window performance measurements.
