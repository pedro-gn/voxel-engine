# Elovox — Sub-project 2d: Terrain Editor (brushes) — Design

Date: 2026-10-03
Status: Draft, awaiting user review
Builds on: `2026-10-02-terrain-toolkit-design.md` (2b, the `TerrainDoc` and its layers) and
`2026-10-03-terrain-editor-design.md` (2c, the editor this extends)

## 1. Context

2b defined three brush layers in `TerrainDoc.layers` and the pipeline reads them: a height
delta per column, a biome per 4 × 4 columns, and sparse 3D density bricks. Nothing writes
them yet. 2c built the editor for ops (pieces): an immutable session, gestures as single
undo steps, a live preview scheduler, and File System Access saving. 2d adds the brushes
that write the layers, on that foundation.

### Decisions made in brainstorming

| Topic | Decision |
|---|---|
| Scope | All three brushes: height, biome and 3D density |
| Height tools | Raise/lower, smooth, flatten |
| Biome tools | Paint the chosen biome, erase (back to unpainted); hard edge on the 4 × 4 grid |
| Density tools | Add/carve and smooth; a sphere at the point under the cursor; Shift locks the depth |
| Preview | Live while painting: **≤ 150 ms** request to visible mesh per update, radius-16 brush |
| Transport | Sparse tiled layers and a generic `engine.terrain.patch`, instead of a full `setDocument` per update |
| Layer overlay | Kept: a "show layers" toggle that tints painted biome cells and the height delta |

### The problem 2d must solve

Every `setDocument` structured-clones the whole document to the sim and to every
generation worker. Each one then validates it and decodes the base64 layers. A full 1024²
height raster is about 2.7 MB of base64. Doing that on every brush update cannot meet a
live budget, and the cost would grow with how much of the map is painted. The 2c spec
already listed "an incremental document update (raster deltas)" as a 2d need.

### Assumptions

- Brushes act in world space. Moving an op later does not move the paint.
- The height layer is a delta added after the ops. Smooth and flatten act on the final
  height (ops + delta) and store the difference in the delta, so an area flattened over
  an op stops being flat if that op changes later. This is accepted for a dev tool.
- No document has layer data yet; the showcase has `layers: {}`.
- One editor, one user, one browser tab, as in 2c.

## 2. Scope and success criteria

### In scope

1. `@elovox/terrain`: the sparse tiled layer format, decoded layers in memory, height in
   1/16 block, the density clamp, `TerrainPatch`, `diffLayers`, `sampleHeights` and
   `sampleDensity`, and the generator's `patch`.
2. Engine: `engine.terrain.patch` and the generator module's optional `patch` hook.
3. `@elovox/terrain-editor`: brush math in `core/`, layer-aware dirty areas and preview,
   and in `ui/` the mode tabs, the brush panel, the cursors and the layer overlay.

### Out of scope

- Painting blocks or textures directly; importing a heightmap image; mirroring and
  stencils; brushes that create ops; region select and copy.
- Bringing the 2c op drag under 150 ms. `patch` makes op deltas possible, but they are a
  follow-up.

### Success criteria

1. Every tool of the three brushes works on the showcase, with undo and redo. The user
   approves this at checkpoint 1 (§10).
2. A moving radius-16 height stroke updates the world in **≤ 150 ms** from request to
   visible mesh per update, on the user's laptop, measured on the showcase **after a
   512² area has been painted** (so the cost is shown not to grow with painted area).
3. Undo and redo restore the world exactly: the voxels after undo equal those before the
   stroke.
4. Saving and reopening gives the same world, and the file holds only painted tiles.
5. Every existing test passes, and the golden column hashes of the showcase do not change.

## 3. Layer format (`@elovox/terrain`)

### In the file (JSON)

```ts
interface TerrainLayers {
  /** Int16 height delta in 1/16 block. A tile covers 64 × 64 columns. */
  height?: { tiles: TileRef[] }
  /** Uint8 per 4 × 4 columns: 0 = unpainted, k = biomes[k - 1]. A tile covers 16 × 16 cells (64 × 64 columns). */
  biome?: { tiles: TileRef[] }
  /** Unchanged: 8³ Int8 samples spaced 2 blocks apart, 1/8 block per unit. */
  density?: { bricks: BrickRef[] }
}
/** x and z count tiles. data: little-endian base64, as today. */
interface TileRef { x: number; z: number; data: string }
```

- Tiles at the world's far edge are full size; samples outside the world are ignored.
- An all-zero tile or brick is never written. Erasing paint shrinks the file again.
- Tile keys are unique; a duplicate key is a validation error.
- The format stays `version: 1`. No document holds layer data, so the format changes in
  place without migration. A full-raster `RasterRef` (the 2b form) is rejected with an
  error that says the format changed.

### In memory (validated `TerrainDoc`)

Layers are **decoded**: each tile holds a typed array (`Int16Array`, `Uint8Array`,
`Int8Array`).

```ts
interface LayerTile<T> { x: number; z: number; values: T }
interface LayerBrick { x: number; y: number; z: number; values: Int8Array }
interface DecodedLayers {
  height?: LayerTile<Int16Array>[]
  biome?: LayerTile<Uint8Array>[]
  density?: LayerBrick[]
}
```

- `validateTerrainDoc` decodes the base64; `serializeTerrain` encodes it. The validator
  also accepts already-decoded layers (checking lengths and ranges), which is what
  `setDocument` and `configure` receive from the editor.
- With typed arrays, a `setDocument` after an op edit clones memory instead of decoding
  base64 in each worker: about 2 ms per worker for a fully painted 1024² height layer.
- The session keeps structural sharing: a stroke creates new arrays only for the tiles it
  touches. Tile objects are never mutated after they enter a document.

### Height precision

The height delta is stored in **1/16 block** (fixed point, range ±2048 blocks). With whole
blocks, a stroke at strength 0.3 per dab would round to nothing and smoothing would step.
The pipeline adds `value / 16` to the height before rounding the column top. The slope is
computed from the rounded tops, so it does not see the fraction.

### Density clamp

Today the column density starts at `top − y − 0.5`, which grows with depth. With the
layer's ±16-block range, carving deeper than about 16 blocks below the surface would be
impossible, and the brush would need more force the deeper it goes. The pipeline changes to:

```
d = clamp(top − y − 0.5 ⊕ volume ops, −4, 4) + densityLayer
```

- The clamp keeps the sign of `d`, and volume ops combine with max and min. Where no
  density layer applies, solidity is therefore unchanged and the golden hashes hold.
- With a layer, the brush responds the same at any depth: about 4 units turn rock to air
  or air to rock, at the surface or 40 blocks down.

### Reads for the editor

- `sampleHeights(terrain, rect)` returns the height before the layer (base + height ops) as
  a `Float32Array`, from the same code as the pipeline's height stage.
- `sampleDensity(terrain, points)` returns the total density (clamped, plus the layer) at
  given points, from the same code as the volume stage.

The brushes read these, not `engine.world`. The world lags a step behind during a stroke,
and reading it would apply repeated dabs over stale heights.

## 4. Engine: `engine.terrain.patch`

### API

The engine stays unaware of what a layer is:

```ts
interface EngineTerrain {
  // ...setDocument, regenerate
  /** Applies an incremental change to the configured document. Rejects with EngineError 'terrain'. */
  patch(patch: unknown, transfer?: Transferable[]): Promise<void>
}

interface GeneratorModule {
  // ...generateColumn, configure
  /** Applies an incremental change to the configured document. Throw to refuse it; nothing changes. */
  patch?(patch: unknown): void
}
```

### Flow

1. The main thread posts `{ type: 'patchTerrain', id, patch }` to the sim, transferring
   `transfer`.
2. The sim calls `generator.patch(patch)` on its own generator (used when there is no
   pool). If it throws, the sim answers with the error and forwards nothing.
3. `GenPool.patch(patch)` posts it to every generation worker and **increments the epoch**,
   like `configure`. Columns in flight from before the patch are ignored, and an active
   regeneration is cancelled and queued again, as `setTerrain` does today.
4. The promise resolves once the sim has applied the patch. A `regenerate` posted after it
   on the same port therefore uses it.

### Errors

| Situation | Behaviour |
|---|---|
| The generator has no `patch` | Rejects with `EngineError('terrain', 'generator does not support patches')` |
| The sim's generator refuses the patch | Rejects with its message; nothing changes anywhere |
| A worker refuses a patch the sim accepted | Fatal: the workers' state diverged (like a dead worker in 2b) |

### The terrain patch

```ts
interface TerrainPatch {
  height?: { x: number; z: number; values: Int16Array | null }[]   // null removes the tile
  biome?: { x: number; z: number; values: Uint8Array | null }[]
  density?: { x: number; y: number; z: number; values: Int8Array | null }[]
}
```

- `createTerrainGenerator().patch` validates keys, lengths and ranges (a biome index at
  most the number of biomes, a key inside the world), then replaces the tiles in the
  compiled layers. `HeightLayer`, `BiomeLayer` and `DensityLayer` change from a full raster
  to a map of tiles; `DensityLayer.bounds` and `touches` follow.
- `diffLayers(before, after): TerrainPatch` compares the tile lists by object identity,
  which is cheap thanks to structural sharing. The editor never builds a patch by hand.
- The sim forwards a structured clone to the workers; only the main thread's copy to the
  sim is transferred.

## 5. Editor core: brushes (`core/`, no DOM)

### Strokes

- A stroke is a gesture: pointer down calls `session.begin(label)`, each dab calls
  `update(doc)` with the new layers, and pointer up calls `commit()`. One stroke is one undo
  step; Esc cancels it.
- History stores before and after documents. Tiles are shared, so a step costs only the
  tiles it touched (8 KB per height tile).
- The session's per-update validation is skipped for layer-only updates. Brushes cannot
  produce an invalid document, since every value is clamped by construction. A seeded
  property test checks that any sequence of dabs yields a document `validateTerrainDoc`
  accepts.

### Dab spacing

Along a drag, dabs are placed every `radius × 0.25` blocks (at least 1), interpolated
between pointer events. The strength therefore does not depend on mouse speed or frame rate.

### Common parameters

Radius (2–64 blocks), strength (0–1) and falloff (0–1: the fraction of the radius over
which a smoothstep fades to zero; 0 is a hard edge). They are kept per tool for the
session and are not saved in the document.

### Height

The weight of a column is `w = strength × falloff(distance)`, and `H = sampleHeights + delta`.

| Tool | Per dab |
|---|---|
| Raise / lower | `delta += ±w × 1 block`; Ctrl inverts |
| Smooth | `delta += w × (mean of H over 3 × 3 − H)` |
| Flatten | `delta += w × (target − H)`, where the target is H under the cursor when the stroke began |

The result is rounded to 1/16 and clamped to ±2048 blocks. The compiled terrain behind
`sampleHeights` is rebuilt only when anything but the layers changes, never during a stroke.

### Biome

Every 4 × 4 cell whose centre lies inside the radius takes the chosen biome (or 0 to
erase). Strength and falloff do not apply; a cell is discrete.

### Density

Over the 2-block sample grid inside the sphere:

| Tool | Per dab |
|---|---|
| Add / carve | `delta += ±w × 2 blocks`, clamped to ±16; Ctrl inverts |
| Smooth | `delta += w × (mean of D over 3 × 3 × 3 − D)`, where D is `sampleDensity` |

- A brick left all zero is removed.
- **Sphere centre:** the point where the cursor ray hits the world (a voxel raycast through
  `engine.world`). With Shift held, the centre stays at the camera distance of the stroke's
  first hit, so a stroke can keep carving into a tunnel.

### Dirty area (`diffArea`)

Today any change to `layers` dirties the whole world. Instead, for each tile that differs
by identity, the values are compared and the rectangle of changed samples is taken:

- Height and biome: the changed columns (a biome cell is 4 × 4 columns).
- Density: the changed samples ± 2 blocks (the trilinear reach).
- Then the existing `toArea`: pad by `AREA_PAD` for slope, trees and rocks, and round out
  to chunk columns.

A radius-16 stroke dirties about 2 × 2 to 3 × 3 chunk columns. The `JSON.stringify`
comparison of global fields no longer sees `layers`.

### Preview scheduler

The rule "the document changed → `setDocument`" becomes:

- Only layers changed since the last send → `patch(diffLayers(sent, latest))`.
- Anything else changed → `setDocument(latest)`, layers included (decoded).

Everything else stays as in 2c: back-pressure, one request in flight, union of pending
areas, the latest document wins. A `patch` rejection pauses the preview and shows its
message, as a `setDocument` rejection does today.

## 6. UI

### Modes

- A tab bar in the toolbar: **Ops · Height · Biome · Density** (keys 1–4). Esc during a
  stroke cancels it; outside one it returns to Ops.
- Ops is 2c as it is. In a brush mode, op handles and outlines hide, the op selection is
  kept, and the left button paints. The orbit camera stays on MMB/RMB.
- The mode cannot change during a stroke.
- The plan checks that keys 1–4 are free in the editor scene.

### Brush panel

It takes the inspector's place in brush modes and is built from the same field widgets
(`panels/fields.ts`):

- Tool buttons. Height: raise/lower · smooth · flatten. Biome: paint · erase. Density:
  add/carve · smooth.
- Radius, strength and falloff: slider plus numeric box.
- Biome: a select of `doc.biomes` names, each with a colour swatch.
- `[` and `]` shrink and grow the radius (× 0.8 and × 1.25). Ctrl inverts raise/lower and
  add/carve while held.

### Cursors (three.js objects in `engine.scene`, updated every frame)

- **Height and biome:** a circle draped on the terrain plus an inner ring where the falloff
  starts. It uses the handles' `groundSampler` and draws with `depthTest: false`. For biome,
  the inner ring hides and the 4 × 4 cells under the circle are highlighted.
- **Density:** a wireframe sphere at the aim point and a small marker at the ray hit. With
  Shift held, the sphere changes colour to show the locked depth.
- The cursor hides when the ray misses the world or the pointer is over a panel.

### Layer overlay

A "show layers" toggle in the toolbar:

- Biome mode: painted cells tinted with their biome's swatch colour.
- Height mode: the delta tinted blue (down) to red (up).
- Drawn as a low-resolution texture projected along y onto the terrain, only over painted
  tiles, and rebuilt for the touched tiles after each update. Density mode has no overlay.

### Status and sandbox

- The 2c status line as is (`regen 84 ms · 4 chunks`, "updating…", the last error).
- No new scene: `?scene=terrain&edit` gains the modes.

## 7. Error handling

| Situation | Behaviour |
|---|---|
| `patch` rejects | Preview pauses; status shows the message; the document stays editable |
| `regenerate` rejects | As 2c: the area stays untouched, the status shows the error, the next edit retries |
| Opening a file with the 2b full-raster layers | Validation error naming the field and saying the format changed |
| A stroke would push a value past its range | Clamped; never an error |

## 8. Testing

| Area | Tests |
|---|---|
| `terrain` format | JSON ↔ decoded round trip; wrong tile size, a key outside the world, a duplicate key, a biome index above the count and the old full raster are rejected with the error's path; all-zero tiles are not serialized |
| `terrain` generation | A fractional (1/16) height delta; the density clamp: without a layer the output is identical (golden hashes), and with one, carving 40 blocks down takes the same strength as at the surface; `sampleHeights` and `sampleDensity` match what the pipeline generates |
| `terrain` patch | `configure(doc)` then `patch(p)` generates the same columns as `configure` with the painted document (the key equivalence test); an invalid patch changes nothing; `diffLayers` works by identity |
| `engine` | `patch` reaches the sim and the workers; columns of an old epoch are dropped; an active regeneration is redone; a generator without `patch` gives `EngineError` |
| `core` brushes | Each tool on a small grid; dab spacing does not depend on how the drag is split into events; the ±2048 and ±16 clamps; the seeded property test that dabs always yield a valid document (no fast-check in the repo, so a seeded loop) |
| `core` area | Area = rectangle of changed samples + `AREA_PAD`, never `'all'` for a layer change; ±2 reach for density |
| `core` preview | Layers only → `patch`; ops changed → `setDocument`; both in one window → `setDocument` |
| E2E | `?scene=terrain&size=256&edit`: Height mode, a raise stroke driven through `window.__elovox`, the regeneration completes, the column under the stroke rises, Ctrl+Z restores it; the same for a biome stroke |

**Bench:** a Playwright script (the 2c pattern, through `window.__elovox`) runs a
radius-16 height stroke and reports ms per update, before and after painting 512² of height.

## 9. Package layout changes

```
packages/terrain/src/layers/
  tiles.ts          tile constants, encode/decode, checkLayers for the tiled format
  layers.ts         HeightLayer, BiomeLayer, DensityLayer over tile maps
  patch.ts          TerrainPatch, diffLayers, applyPatch (validation + replace)
  sample.ts         sampleHeights, sampleDensity
packages/terrain-editor/src/core/
  brush.ts          dab spacing, falloff, per-tool dab functions over decoded layers
  area.ts           layer-aware diffArea
  preview.ts        patch vs setDocument
packages/terrain-editor/src/ui/
  brushes/          cursor, overlay, brush panel, mode tabs
```

The plan may split or merge files where the code says otherwise.

## 10. Checkpoints with the user

1. **Tools:** how the three brushes feel on the showcase, the cursors and the overlay. The
   user tunes strengths and curves here.
2. **Performance:** the numbers of §2 criterion 2 on the user's laptop.

## 11. Follow-ups this spec does not address

- Op deltas through `patch`, to bring the 2c op drag under its budget.
- A binary file format if documents with large painted areas grow too big as JSON.
- Painting blocks directly, heightmap import, stencils.
