# Elovox — Sub-project 4b: View distance — Design

Status: draft for review by the expert (sub-project 4 decider). Q1 and Q2 were ruled in brainstorming on 2026-10-08.
Branch `feat/view-distance`, from `main` 90e5c97. Part of sub-project 4 of the core spec ("View distance & first-person").

## 1. Context and measurement

The world (up to 1024 × 128 × 1024) is generated and meshed whole. Chunks draw through one `BatchedMesh` per 4 × 4-chunk
region and layer (4a #3). There is no view-distance setting and no LOD. The last number for the full 1024² world (33 fps,
from 2a) predates batching. It was re-measured before this design (window #1, production build, Edge headed, 1920 × 889,
180 Hz display; worst of two runs; data in `docs/superpowers/research/2026-10-08-view-baseline/`):

| Scene, pose | fps median / p5 | CPU frame median / p95 (ms) | GPU ms | draws | triangles |
|---|---|---|---:|---:|---:|
| `world`, orbit 70 | 180 / 89.9 | 3.5 / 5.5 | 1.5 | 921 | 2.5 M |
| `world`, orbit 400 | 179 / 89.7 | 5.9 / 8.9 | 1.6 | 3,808 | 3.2 M |
| `world`, orbit 400 low pitch | 179 / 89.3 | 5.3 / 7.9 | 1.4 | 3,903 | 2.9 M |
| `world`, ground (pitch 0.15, distance 8) | 177 / 89.9 | 4.7 / 6.4 | 1.6 | 2,866 | 3.5 M |
| `terrain` showcase, orbit 70 | 180 / 89.9 | 4.3 / 6.6 | 1.3 | 910 | 2.0 M |
| `terrain`, orbit 400 | 90 / **60.0** | 8.2 / 12.0 | 1.6 | 4,343 | 2.9 M |
| `terrain`, orbit 400 low pitch | 90 / **60.0** | 8.0 / 11.0 | 1.5 | 4,590 | 2.8 M |
| `terrain`, ground | 90 / **59.8** | 9.1 / 13.4 | 1.4 | 2,873 | 2.6 M |

**The frame is CPU-bound, not GPU-bound.** Triangles cost the GPU almost nothing. A dev-build CPU profile of the terrain
scene, taken in the same window, splits the busy main-thread time like this (attribution only):

| Share of main-thread time | orbit 400 | ground |
|---|---:|---:|
| three's per-render-object work (`getForRender` + `updateForRender`: cache keys, bindings, uniform writes) | ~43% | ~50% |
| `BatchedMesh.onBeforeRender`: per-chunk sphere, matrix multiply, frustum test and sort, every pass | 18% | 16% |
| shadow pass (inclusive; it renders nested inside the main pass) | 45% | 14% |
| `scene.updateMatrixWorld` (2,093 objects; 1,666 are decoration meshes, 50 of them visible) | 9% | 10% |
| the `drawIndexed` loop (the "draws" above: one per chunk per pass) | 6% | 9% |
| decoration distance cull | 2.5% | 3% |

Two conclusions follow. A chunk's draw inside a batch is cheap; what costs is render objects and the per-chunk cull. A
simplified-mesh LOD would cut triangles, which is not what was measured. Merged far-region geometry would only remove the
far share of the draw loop and cull, at the largest complexity (rejected in Q2, option B).

## 2. Decisions

| Topic | Decision |
|---|---|
| Purpose (Q1) | View distance is a **setting with a visible contract**: the world beyond it is not drawn, and the fog dissolves the edge into the sky, never a hard cut. LOD comes in only on a measured miss (none was measured) |
| Approach (Q2) | **Part 1:** CPU cuts that leave the picture identical. **Part 2:** `Quality.viewDistance`. Each part gets its own A/B |
| Default | `viewDistance: Infinity`. Every visible pixel at the default stays as on `main`. A finite default (and its fade) is a user checkpoint, proposed with URLs and camera poses (§7) |
| Out of scope | Streaming, unloading, generating or meshing by distance; simplified LOD meshes; merged far geometry; a first-person camera (fpcontrol, 4d); the value engine.ts passes as `viewDistance` to Visuals (fpcontrol) |
| `?nobatch` | Keeps working with view distance (per-chunk meshes beyond R are hidden). It remains the reference picture for part 1 |

## 3. Success criteria

- **fps p5 ≥ 60**, worse of two runs, at all 4 poses in both 1024² scenes (`?scene=world`, `?scene=terrain`), **at the
  default R**. Today the terrain ground view is at 59.8 and orbit 400 at 60.0. The default R draws everything, so part 1
  alone must meet this. If part 1 falls short, the residual miss goes to the expert with the profile and the remaining
  candidates. A finite default R (checkpoint 2, §7) is one of them.
- **Same picture at the default:** the e2e pixel diff stays ≤ 0.5% of pixels (tolerance 8 per channel), on WebGPU and
  WebGL2 (§6).
- **No regression** in the interleaved A/B of `main` against this branch on the living benchmark (idle and work phases,
  default and far cameras): CPU frame median and fps do not get worse. This is the exit condition.
- With a finite R: at that R, nothing beyond R is drawn in either pass: chunks, decorations, water surfaces, and shadow reach.
  The edge fades fully to the fog/sky colour at R at any height, on any preset, with fog on or off.
- Every existing unit and e2e suite passes, including water hashes and unit replay; `npm run typecheck` is clean.

## 4. Part 1 — CPU cuts, same picture

Each item is its own commit and its own A/B (§6). An item that shows no measured gain is reverted.

### 4.1 The engine's own batch cull (`render/chunkCull.ts`, `chunkBatches.ts`)

Replace `BatchedMesh.onBeforeRender`'s cull with ours. Per batch, `perObjectFrustumCulled = false` and
`sortObjects = false`, and an `onBeforeRender` that builds the multi-draw list itself:

- Each chunk gets a **precomputed world bounding sphere** when it is set: centre = chunk centre, radius = the 32³
  box's half-diagonal. Chunks never move, so no per-pass `getMatrixAt` / `getBoundingSphereAt` / `applyMatrix4` is needed.
  The spheres live in a `Float32Array` per batch, indexed by instance id.
- Per pass: one frustum from the pass camera, built in **world space** (the batch matrix is the identity). One
  sphere-vs-frustum test per active chunk, plus the view-distance test of §5.1 in the same loop. Draw ranges are written
  straight into `_multiDrawStarts` / `_multiDrawCounts` / the indirect texture, as three does.
- **No sort.** The opaque and cutout (alpha-test) layers depth-test, so draw order does not change the picture. GPU time is
  1.2–1.6 ms, so front-to-back order is not worth its CPU cost. The A/B checks GPU ms does not rise.
- **Shadow pass** (ruled to lod): the same loop runs with the shadow camera's frustum. This is the per-chunk shadow-pass
  culling. three already ran it (trap 4 only removed the duplicate in `onBeforeShadow`), so the gain is its cheaper cost.
  Pass detection and the restore of the outer list after a nested pass stay as trap 4 describes.
- The pure maths (sphere setup, frustum and distance tests, list building over typed arrays) lives in `chunkCull.ts`,
  unit-tested without three's renderer. `chunkBatches.ts` keeps the three wiring.
- `?cull=three` (sandbox) / `EngineOptions.threeCull` (debug, default false) keeps three's cull, as the in-build reference
  for the pixel diff and the A/B. It is removed at the end of the sub-project if the user agrees.

### 4.2 Bigger regions: `REGION` 4 → 8, only on a measured gain

Region batches are render objects, and their per-object cost is the largest share. Eight-chunk regions cut the batches of
a 1024² world from 64 + 52 to 16 + ~14 per pass. This item enters only if the A/B shows a gain **and** these checks hold:

- **Edit latency:** frames from `submit(setBlock)` to the edited chunk's new mesh on screen (`meshVersion`), measured by
  a new probe in `view-bench.spec.ts`. It is not worse than with REGION 4, and stays within the core spec's 2-frame target
  wherever REGION 4 meets it.
- **Remesh cost:** `ChunkBatches.set` time for an in-place, appended and compacting remesh (unit micro-bench in
  `chunkBatches.test.ts`, timings logged, not asserted). A compaction of a 4× bigger batch must not cause a visible
  hitch: the frame's max CPU during a 128² terrain edit is no worse than with REGION 4 (A/B).
- **Memory:** initial batch capacity at 1024² is already ~112 MiB per side, half of it in mostly empty cutout batches.
  Whatever the region size, **cutout batches start smaller** (their own `VERTICES_PER_SLOT` / `INDICES_PER_SLOT`,
  sized from the measured cutout share; growth handles the rest). Initial capacity is logged before and after, and
  must not grow.

### 4.3 Decorations cost nothing while hidden (`render/decorations/**`, ruled to lod)

- A decoration mesh outside the selection leaves the scene graph: it is detached from `DecorationMeshes.group`, not
  set invisible. It comes back when selected. Then neither `updateMatrixWorld` nor the render list walks 1,600 hidden
  meshes. Its `matrixWorld` is computed once at creation (static, `matrixAutoUpdate = false`).
- `cull()` re-selects only when the camera has moved ≥ 2 blocks or the entries changed since the last selection.
  `CHUNK_REACH` (28) leaves ≥ 5 blocks of slack past the farthest column, so a 2-block lag cannot drop visible grass. The
  grass fade is per-instance in the shader and stays exact.

## 5. Part 2 — `Quality.viewDistance`

### 5.1 The setting

- `Quality.viewDistance: number`, in blocks; `Infinity` (the default) or a finite value in [64, 4096]. It is validated
  in `mergeQuality` like the other fields. Set with `engine.quality = { viewDistance: 384 }`. It applies on the next frame,
  with no reload and no remesh. It is independent of the camera mode and never reads `OrbitCamera`.
- **Distance** is 3D, from the camera to the **nearest point** of a chunk's (or region's, or water column's) box. That
  matches the fog, which works on view-space distance.
- Sandbox: `?view=<blocks>` sets it at load, and the controls panel gets a view-distance field (additive hunks in
  `main.ts` / `controls.ts`), so the user can check it by hand.
- `EngineStats.chunksDrawn` (appended field): chunk draws of the main pass in the last frame, batched and unbatched.
  Tests and the benchmark read it.

### 5.2 What R removes

| What | How | File (owner) |
|---|---|---|
| Region batches | `visible = false` when the region box's nearest point is beyond R (saves the render object in both passes) | `chunkBatches.ts` (lod) |
| Chunks in a visible region | skipped in the §4.1 loop, in both passes | `chunkCull.ts` (lod) |
| Unbatched chunk meshes (`?nobatch`, translucent and liquid layers) | `visible` per mesh, refreshed when the camera moves ≥ 2 blocks or R changes | `chunkMeshes.ts` (lod) |
| Decorations | effective radius = min(`decorationRadius`, R) for the selection and the shader fade | `visuals.ts`, `decorations/**` (lod) |
| Water surfaces and curtains | the one hook below | `water/waterSurface.ts` (perf; one hunk ruled to lod) |
| Shadow reach | `far = min(shadowDistance(viewDistance()), R)` in `Visuals.frame`; `viewDistance()` stays fpcontrol's value | `visuals.ts` shadow lines (lod) |
| Camera far plane | `camera.far = R + 64` (R plus a chunk diagonal; the cull keeps chunks whose nearest point is within R); 3000 at `Infinity` | `engine.ts` camera.far line (lod) |

The water hook (the whole change to `waterSurface.ts`; no change to `surfaceView.ts` or the water materials):

```ts
// Slot gains one field:
  inRange: boolean
// create(): the new slot's flag comes from the last range (`inRange: this.near(cc)` in the slot literal).
// sync(): the two existing visibility expressions gain `&& s.inRange`:
      s.surface.visible = anyDrawn(d.info) && s.inRange
    s.curtains.visible = cs.count > 0 && s.inRange
// Two fields and two methods:
  private eye = { x: 0, y: 0, z: 0 }
  private range = Infinity

  /** View distance: hides the chunk columns whose nearest point is farther than `range` blocks from `eye`; Infinity shows all. */
  setRange(eye: { x: number; y: number; z: number }, range: number): void {
    this.eye = { x: eye.x, y: eye.y, z: eye.z }
    this.range = range
    const n = this.view.ccCount
    for (const [key, s] of this.slots) {
      const cc = key % n, inRange = this.near(cc)
      if (inRange === s.inRange) continue
      s.inRange = inRange
      const d = this.view.column(cc, (key - cc) / n)
      s.surface.visible = inRange && d !== null && anyDrawn(d.info)
      s.curtains.visible = inRange && d !== null && d.curtains.count > 0
    }
  }

  private near(cc: number): boolean {
    if (this.range === Infinity) return true
    const x0 = (cc % this.view.cx) * 32, z0 = Math.floor(cc / this.view.cx) * 32, e = this.eye
    const dx = Math.max(x0 - e.x, 0, e.x - x0 - 32), dz = Math.max(z0 - e.z, 0, e.z - z0 - 32)
    const dy = Math.max(-e.y, 0, e.y - this.height)
    return dx * dx + dy * dy + dz * dz <= this.range * this.range
  }
```

The plan rechecks this hunk against the file at the time it is applied, because perf's #2 may have changed the data
source. `Visuals.frame` calls `setRange` every frame (one loop over at most a few hundred slots). At `Infinity` every flag
stays true, so the picture and the behaviour are as on `main`.

### 5.3 The edge: fog and sky (`sky.ts`)

Today's fog is `(1 − e^(−4d²)) · e^(−y·heightFalloff)`, with d = (dist − near) / (far − near). The height term leaves a
mountain top at y = 100 only ~30% fogged even past `fog.far`, so it cannot hide a cut. View distance adds a
**height-independent edge term**: `edge = smoothstep(R · (1 − EDGE_SHARE), R, dist)`, with EDGE_SHARE = 0.25, and
factor = max(fog, edge). The colour is the fog colour (already a blend towards the sky horizon by
`fog.followHorizon`). So at R every surface is exactly the fog colour, the same colour the sky backdrop shows at the horizon.

- At `Infinity` the edge uniform is set so that `edge` is exactly 0 for every distance, and max(fog, 0) = fog: the
  default picture is unchanged.
- With fog **off** (`effects.fog = false`) and R finite, the scene gets an edge-only fog node (the same edge term, no
  distance/height fog), so a finite R never shows a hard cut.
- The sky dome and clouds do not change.

## 6. Testing

- **Unit (vitest, engine):**
  - `chunkCull.test.ts`: spheres, world-space frustum tests against three's `Frustum` for the same camera, distance to a
    box's nearest point, list building with view distance;
  - `settings.test.ts`: `viewDistance` validation and the default;
  - `chunkBatches.test.ts`: the cull writes the same ranges three's cull would for visible chunks (as a set, order
    free), the nested-pass restore, region visibility at R, the cutout capacity, and the remesh micro-bench of §4.2;
  - decorations: hidden meshes are out of the group, and re-selection happens only after ≥ 2 blocks of movement;
  - water hook: the `inRange` flag combines with the existing `visible` rules;
  - fog/sky: uniform values at `Infinity` and at finite R, and the edge-only node with fog off;
  - shadow clamp: `min(shadowDistance, R)`.
- **e2e, same picture (extends `batching.spec.ts`; WebGPU and WebGL2; ≤ 0.5%):**
  - the existing batched vs `?nobatch` pair, now with our cull;
  - our cull vs `?cull=three`, on the 256² scene and on a 1024² `?still` terrain at an orbit-400 pose;
  - default (`Infinity`) vs `main`'s path: one manual cross-check of `main` against the branch at the 4 bench poses ×
    2 scenes before the final report (screenshots diffed with the same in-page decoder), recorded in the review.
- **e2e, view distance (`view-distance.spec.ts`):**
  - at R = 256 on the 1024² terrain: `chunksDrawn` drops, no batch beyond R is visible, there are no console errors, and
    `?nobatch` at R = 256 drops too;
  - a screenshot pair at the ground pose (R = 256 vs `Infinity`) is attached for the user checkpoint.
- **Benchmarks (each inside a granted window; production build, Edge headed; interleaved alternating-order A/B in one
  session):**
  - per part-1 item: `view-bench` at 4 poses × 2 scenes, with the item on vs off;
  - after part 1: the gate run (worse of two runs, default R);
  - part 2: R = Infinity vs R = 512 / 384 / 256, for the checkpoint;
  - at the end: the living-bench A/B of `main` vs branch (exit condition).

## 7. User checkpoints (through the expert)

1. **Edge look at a finite R:** `?scene=terrain&view=384` and `&view=256`, ground pose and orbit 400 low pitch, every
   preset. This is where the user sees the fade.
2. **Default R:** stay at `Infinity` (no visible change), or adopt a finite default, if the user prefers it after 1. That
   would change the look and is decided only there.

## 8. Batching follow-ups folded in (from the 4a review)

- Cutout batches start smaller (§4.2).
- `EngineStats.shadowCasters` gets its doc comment: it counts render objects, batches plus meshes.
- The `THREE.TSL: Vertex attribute "normal" not found` warning per batch build: find its source (the batch geometry has
  no `normal`; the chunk material computes its own) and silence it at the source, not in the console.
- Remove the unused `ChunkBatches.setMaterial`.
- Old GPU buffers after a grow are freed explicitly, by disposing the replaced attributes through the renderer's backend
  if three r186 offers a path. If it does not, this is recorded as a limit.
- `PassGuard` recovery: the guard is reset at the start of every frame, so a render that threw cannot leave a stale stack.

## 9. Deliverables

- This spec; the plan `docs/superpowers/plans/2026-10-08-view-distance.md`; research JSON in `docs/superpowers/research/`;
  the final report `docs/superpowers/reviews/2026-10-08-view-distance.md`.
- A `CONTEXT.md` entry for **View distance** (appended at the end).
- Work on branch `feat/view-distance`; never pushed or merged by this worker.
