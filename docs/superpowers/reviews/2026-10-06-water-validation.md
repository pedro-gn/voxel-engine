# Multi-layer water validation — 2026-10-06

Scope: close the local functional and visual review of water (3d checkpoints 1–5). Laptop performance measurements remain checkpoint 6.

## Functional evidence

| Scenario | Result |
|---|---|
| Dam hole | The existing browser test drains the lake into the valley. The captured jet is lit and falls out of the opening. Engine tests cover its outgoing arc and the light sampled below its roof. |
| U-tunnel, isolated scene | Settles after 1,583 ticks. Lake surface 27.90625; shaft surface 27.90234375. No water-volume change and no consistency errors. |
| Pierced roof, isolated scene | Settles after 1,059 ticks. More than 490 of the original 512 water blocks reach the cave. Water remaining above the pond bed is below the visibility threshold in every column. No water-volume change and no consistency errors. |
| Bridged canal, isolated scene | At 1,000 ticks water has crossed both bridges and reached the valley. Both lower segments have free surfaces; both decks remain solid and dry on top. Water volume is exact. |
| Flood regression | The lake drains through the breach, the dug channel fills to its far end, and sand lands correctly. The initial water surface renders at the expected lake level without console errors. |
| Roof edit over the lake | Browser test passed: placing/removing a roof preserves both interpolation endpoints at level 28 across ranks 0 and 1; the old layer's quad is hidden. |

## Checks

- Focused engine water tests: **58 passed** in 7 files.
- Sandbox caves tests: **6 passed**, including three new isolated scene checks.
- Workspace typecheck: **passed**.
- Original browser suite: **5 passed, 1 skipped**. The skipped test is the explicitly opt-in `E2E_SLOW=1` flood flattening check, which waits approximately 21 minutes.
- Extended browser suite: **4 passed**. It adds the bridged canal's cross-layer corner checks and the roof edit regression, and captures all checkpoint views.
- General scene regression: `world` and `diorama` **passed**, including preset/effect changes and rendered canvas checks. The first `world` run exhausted its 120-second timeout; the final run passed in 85.57 seconds with a 300-second limit, no errors and no retries. Its JSON result is saved in `test-results/water-checkpoints/world-smoke.json`.

Across the water and general scene runs, **9 distinct E2E tests passed** (7 water, 2 general scenes), along with **64 focused unit/integration tests**. Screenshots of the dam, drained pond, shaft, canal, flood scene and completed roof edit were inspected. The canal E2E checks all four shared corners against its neighbouring rank-0 quads under both bridges; it also verifies the solid decks and dry upper cells.

Local screenshot copies are kept in `test-results/water-checkpoints/` (ignored by Git):

- [Dam hole](../../../test-results/water-checkpoints/dam-hole.png)
- [Drained pond above the cave](../../../test-results/water-checkpoints/pierced-roof.png)
- [U-tunnel and shaft](../../../test-results/water-checkpoints/u-tunnel-shaft.png)
- [Canal under both bridges](../../../test-results/water-checkpoints/bridged-canal.png)
- [Flood water](../../../test-results/water-checkpoints/flood-water.png)
- [Lake after placing/removing its roof](../../../test-results/water-checkpoints/lake-after-roof-edit.png)

This first local review used bundled headless Chromium and **WebGL2**. The subsequent [desktop quality/performance review](2026-10-06-water-performance.md) validated native WebGPU, completed the full suite and met the user-selected PC's performance budgets. A different laptop remains unmeasured. The short functional runs do not claim the full flood scene has reached its final sleeping state.

## Repeat

From the repository root:

```powershell
npm run test -w @elovox/engine -- test/waterUnderStep.test.ts test/waterBodies.test.ts test/waterLayersWorld.test.ts test/waterSurface.test.ts test/surfaceLayers.test.ts test/layerStore.test.ts test/waterFuzz.test.ts
npm run test -w @elovox/sandbox -- test/caves.test.ts
npm run typecheck
```

From `apps/sandbox`:

```powershell
$env:E2E_PORT = '5185'
npx playwright test e2e/caves.spec.ts e2e/flood.spec.ts e2e/water-render.spec.ts --workers=1 --trace=retain-on-failure
```

On a sandbox that prevents Vitest from renaming its temporary transform files, set `TEMP` and `TMP` to a writable directory under `node_modules/.cache` for the test process. No test or production configuration needs to change.
