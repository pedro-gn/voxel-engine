# Elovox — Sub-project 2b: Terrain Toolkit — Design

Date: 2026-10-02
Status: Approved; implementation plan in `docs/superpowers/plans/2026-10-02-terrain-toolkit.md`
Builds on: `2026-10-01-voxel-core-design.md` (sub-project 1) and
`2026-10-02-visual-polish-design.md` (sub-project 2a), both merged on `main`

## 1. Context

The 2a spec deferred the terrain toolkit to its own spec. That spec required a noise
library (3D density for arches and caves, domain warp, ridged noise), relief
composition, voxel tree and rock placement, and a showcase map that mixes several
reliefs. It also required that the toolkit make any relief possible.

Today the engine has one generator interface, `generateColumn(ctx, cx, cz)`. It runs
serially in the sim worker before tick 0 and writes one 32 × 32 × height column. A
write outside the column throws. The context offers only 2D value noise
(`noise2`, `fbm2`). The world is 1024 × 128 × 1024.

### Decisions made in brainstorming

| Topic | Decision |
|---|---|
| How worlds are made | Both: a hand-designed layout whose regions can be filled procedurally |
| How the layout is authored | An in-engine editor. It is its own sub-project, **2c**. 2b delivers the core and the data format the editor edits |
| What the editor edits | Parametric pieces **and** brush layers: sculpt height, paint biome, sculpt 3D density |
| Reliefs the showcase must show | Plains and hills; mountains and cliffs; arches, overhangs and caves; water (river, lake, coast) |
| Surface and vegetation | Surface rules plus light biomes (a palette with tree and rock density), 2–3 tree types and rocks. New blocks only where the map needs them |
| Terrain representation | A density field with a 2D fast path: 2D height ops plus bounded 3D volume ops |

### Sub-project split

- **2b — Terrain toolkit (this spec):** the noise library, the terrain document, the
  ops, the generation pipeline, features, parallel generation, partial regeneration
  and the showcase map. It has no editing UI.
- **2c — Terrain editor (own spec, later):** UI to place and tune ops, sculpt and paint
  layers, preview with partial regeneration, undo, and save the document.

The layout is **data** (a serializable document), not code. This is what lets 2c
build on 2b without rewriting it.

### Assumptions

- World height stays at 128. Doubling it would double the SharedArrayBuffer memory.
- The world is regenerated from document + seed on every load. Persisting voxel edits
  stays in sub-project 6.
- Water is static. Flow and levels stay in sub-project 3.

## 2. Scope and success criteria

### In scope

1. A new package `@elovox/terrain`: noise, document, shapes, ops, layers, pipeline,
   features, and the `terrainGenerator(doc)` adapter.
2. Engine: parallel generation over a generation worker pool, partial regeneration
   with regional relighting, and the `engine.terrain` API.
3. Sandbox: the `?scene=terrain` scene, the showcase document, and the new blocks and
   placeholder textures.

### Out of scope

- The editor (2c).
- Water dynamics (3) and persisting voxel edits (6).
- World height above 128.
- A binary document format and a node-graph op model.

### Success criteria

1. The showcase shows all four relief groups of §1. The user approves it at the visual
   checkpoints of §10.
2. On a mid-range laptop, a 1024² world generates in **≤ 6 s**, and regenerating a
   128 × 128 area takes **≤ 300 ms** from request to visible mesh.
3. The terrain scene keeps 60 fps at the 3/4 view. If it is draw-bound, the fix is the
   BatchedMesh follow-up already recorded in 2a, and it does not block 2b.
4. Every sub-project 1 and 2a test still passes. The `world` and `diorama` scenes are
   unchanged.

## 3. Architecture

### Package layout

`packages/terrain` is plain TypeScript with no three.js and no workers. It depends on
the engine only for types and `hash32`.

```
packages/terrain/src/
  noise/        value + gradient noise 2D/3D, fbm, ridged, billow, domain warp, cellular
  doc/          TerrainDoc types, validation with error paths, version migration
  shapes/       circle, polygon, path (polyline with width), falloff and profiles
  ops/          height ops (2D), volume ops (3D), registry for custom ops
  layers/       brush rasters: 2D height delta, 2D biome mask, sparse 3D density bricks
  pipeline/     per column: height → density → water → surface → features
  features/     trees and rocks: jittered global grid, stamps clipped to the column
  generator.ts  terrainGenerator(doc) → GeneratorModule (the existing interface)
  index.ts
```

The engine stays unaware of terrain documents. It only gains generic generation
capabilities (§7).

### Data flow

```
TerrainDoc (JSON) ──▶ terrainGenerator(doc) ──▶ generation worker pool ──columns──▶ sim worker
                                                                                   │ writeChunkDense
                                                                                   ▼
                                                                          light ──▶ mesh workers
```

The sim worker stays the only writer to the world.

## 4. The terrain document (`TerrainDoc` v1)

```ts
interface TerrainDoc {
  format: 'elovox-terrain'
  version: 1
  size: [number, number]        // x, z; must equal the world's x, z (y = world height)
  seaLevel: number              // every non-solid voxel below this y is water (column-local: keep inland ground above it)
  blocks?: Partial<BlockNames>  // names of fill, water, log, leaves, pineLeaves and rock blocks (defaults: stone, water, …)
  base: BaseDef                 // the procedural fill: scale, amplitude, octaves, warp
  biomes: BiomeDef[]            // palette: surface rules, tree and rock settings
  biomeRule: BiomeRule          // default biome from height and a moisture noise
  ops: OpDef[]                  // pieces, applied in order
  layers: {
    height?: RasterRef          // Int16 height delta, one sample per column
    biome?: RasterRef           // Uint8 biome index, one cell per 4 × 4 columns
    density?: BrickSetRef       // sparse 3D density: 8³ bricks at 2-block resolution, only where painted
  }
}

interface OpDef {
  id: string                    // stable; the editor selects and edits by id
  type: string                  // a built-in or registered op type
  enabled: boolean
  shape: ShapeDef
  params: Record<string, unknown>   // validated by the op type
  blend?: BlendMode             // height ops only
}
```

### Ops

Each op combines a **shape**, a **profile**, a **blend mode** and **noise**.

- **Shapes:**
  - `circle`: a centre and a radius.
  - `polygon`: a list of points.
  - `path`: a polyline with a width. Width and height can be set per vertex, and a
    volume op's path also carries y.
- **Blend modes (height ops):** `add`, `max`, `min`, `set` and `carve`. Every mode has
  a smooth falloff at the shape's edge.
- **Height ops (2D):**

  | Op | What it makes |
  |---|---|
  | `hills` | The procedural fill inside an area |
  | `mountain` | A ridged peak, or a range along a path |
  | `plateau` | A mesa with terraces and steep walls |
  | `valley` | A valley or canyon along a path, with a V, U or box profile |
  | `river` | Carves the channel, sets the water level and shapes the banks |
  | `lake` | A basin and its water level |
  | `flatten` | A flat building site |
  | `biome` | Paints a biome over an area (border optionally jittered with noise); changes no height |

- **Volume ops (3D):** each declares a bounding box and adds density, subtracts it, or
  both.

  | Op | What it makes |
  |---|---|
  | `arch` | A noisy curved tube between two points |
  | `cave` | A worm tunnel along a 3D path, with an entrance |
  | `overhang` | Carves the base of a wall and/or adds a projecting lip |
  | `blob` | A noisy ellipsoid that adds or subtracts: floating islands, rock spires, giant boulders |

- **Extension:** `defineTerrainOp({ type, kind: 'height' | 'volume', validate, bounds,
  evaluate })` registers a custom op in code. It covers any relief the built-in pieces
  do not.

### Storage

The document is one JSON file. Raster layers are stored as base64 inside it in v1. A
1024² Int16 height layer is about 2.7 MB in base64, which is acceptable. A binary
format can come later if size becomes a problem.

### Validation

`validateTerrainDoc(json)` returns either the typed document or a list of errors, each
with a path and a message (`ops[3].shape.radius: must be > 0`). Each op type validates
its own `params`. An unknown `version` goes through migration, or is rejected with a
clear error.

## 5. Generation pipeline

The pipeline is a pure function of `(doc, seed, cx, cz)`. It runs per 32 × 32 column.

1. **Height (2D):** compute `h(x, z)` on a 34 × 34 grid. The one-column border gives
   the slope. The order is `base`, then each height op whose bounding rectangle
   intersects the column (in document order), then `layers.height`. The same pass
   computes three more values:
   - the **water level**: the maximum of `seaLevel` in open basins, lakes and rivers;
   - the **biome**: `biomeRule`, overridden by `layers.biome`;
   - the **slope**.
2. **Density (3D), only where needed:** a column needs this step if any volume op or
   density brick intersects it. Then `d = (h − y) + Σ volume ops + bricks` is sampled
   on a coarse lattice (stride 4 in x, y and z) and interpolated trilinearly. The
   lattice covers only the y range of the intersecting bounding boxes. Outside that
   range, and in every other column, `solid = y < h`.
3. **Water:** air below the water level becomes water. A river's water level steps
   down in whole blocks along its path, which gives small falls.
4. **Surface:** for each solid voxel, the pipeline knows its depth below the nearest
   air above it and whether it is a ceiling. The biome's surface rules pick the block
   from depth, slope, height, nearness to water, being under water, and being a
   ceiling. Examples: stone on steep walls, sand on banks, gravel on riverbeds, snow
   above a height, sandstone bands on mesas. Below the surface layer the block is
   stone.
5. **Features (trees and rocks):** see §6.

### Performance targets

| Target | Budget |
|---|---|
| Full 1024² world, generation pool of 6 workers | ≤ 6 s |
| Full 1024² world with only 2D ops | about 1–2 s |
| Regenerate a 128 × 128 area, request to visible mesh | ≤ 300 ms |

A Node benchmark reports ms per column for a 2D-only column and for a column with a
volume op.

## 6. Features

- **Placement grid:** a global grid with jitter (cell size around 8 blocks) holds one
  candidate per cell. The cell's hash picks the type and variant. The biome's density
  decides whether the candidate exists.
- **Cross-column stamping:** a column evaluates the candidates of every cell within the
  largest feature radius. For each one it recomputes the ground height at the
  candidate's point with steps 1–2, which are pure. Then it stamps only the part that
  falls inside the column. A tree on a chunk border therefore comes out whole and
  identical on both sides, and columns never communicate.
- **Eligibility:** a candidate is placed only on a sky-exposed surface, not under
  water, and within the slope limit.
- **Trees:** 2–3 voxel types: a broadleaf with clumped canopy, a conical pine, and
  possibly a bush. They are built by rules (a trunk plus noisy leaf clusters), not
  fixed templates, so they vary.
- **Rocks:** noisy blobs of `rock`, from small to large, partly buried.

## 7. Engine integration

### API

```ts
createEngine({
  // ...existing options
  genWorker: () => new Worker(new URL('./gen.worker.ts', import.meta.url), { type: 'module' }),
  genWorkers: 6,   // optional; defaults to the mesh pool's size rule
})

// gen.worker.ts (sandbox)
runGenWorker({ generator: terrainGenerator })

engine.terrain.setDocument(doc)                       // validates, sends to sim and gen workers
await engine.terrain.regenerate({ x0, z0, x1, z1 })   // resolves once the area is replaced
engine.terrain.initial                                // { ms, columns } of the initial generation
engine.on('generated', ({ ms, columns }) => { /* ... */ })   // after each regeneration
```

- Without `genWorker`, generation stays serial in the sim worker, as today. The
  `world` and `diorama` scenes do not change.
- `GeneratorModule` gains an optional `configure(doc)`. The generator receives the
  document by message.
- `GeneratorContext` gains `column`, the column's `Uint16Array`, for direct writes. This
  avoids 131 k bounds-checked calls to `set()` per column.

### Parallel generation

The main thread creates one `MessageChannel` per generation worker and hands one end
to the sim. The sim distributes columns, receives the transferred buffers, and writes
them with `writeChunkDense`. The initial light pass runs after every column has
arrived. Arrival order does not change the result, because each column is pure and
writes do not overlap.

### Partial regeneration

1. The sim rounds the rectangle out to chunk columns and requests those columns.
2. When all of them have arrived, it applies them **atomically between two ticks** and
   bumps the chunk versions. Player edits in the area are overwritten. Pending ghosts
   resolve through their acks as usual.
3. **Regional relight:** clear light in the area plus a one-chunk margin, then
   re-propagate from sky light and the margin's borders with the existing light
   queues.
4. The dirty chunks go to the mesh workers like any other edit.

Regeneration is an editor operation outside the command log. Its timing is not
deterministic, and multiplayer does not need it yet.

A `regenerate` call made while another one is running is queued. A `setDocument` made
while generation is running discards the in-flight results and starts again.

### Error handling

| Situation | Behaviour |
|---|---|
| Invalid document | `EngineError` listing the errors with their paths; the world does not change |
| `doc.size` differs from the world | A clear error at creation |
| An op throws during generation | `fatal` names the op `id` and the column; during regeneration the area is left untouched and the promise rejects |
| A generation worker dies | Fatal during initial generation; during regeneration the promise rejects |

## 8. Showcase map

`apps/sandbox/src/terrain/showcase.terrain.json` is a hand-written 1024 × 1024
document, loaded by the scene `?scene=terrain`. The e2e test uses a separate small
document, `e2e.terrain.json` (256 × 256), with one op of each kind, loaded by
`?scene=terrain&size=256`. A document's `size` must always equal the world's.

| Region | Content |
|---|---|
| North | A ridged mountain range with snowy peaks, a **cave** with a visible entrance on a slope, an **overhang** on a wall |
| East | **Mesas and plateaus** with terraces and sandstone bands, a **canyon** between them, **two stone arches** |
| Centre | **Plains and hills** with forest and open meadows (using the 2a grass and flowers) |
| River | Rises in the mountains, steps down across the plains, and ends in a **lake** |
| South / south-west | A **coast** with a sand beach, sea at `seaLevel`, and a few large rocks |
| Proofs of the generic ops | A `flatten` building site and a small floating island (`blob`) |

Biomes: `temperate` (the default), `alpine` (pines and snow), `mesa` (sandstone, few
trees) and `beach`.

### New sandbox blocks

`snow`, `gravel`, `sandstone`, `sandstone_red` (the mesa bands), `pine_leaves`, and a
pine log if the pine needs one. The procedural painter makes placeholder textures.
The user can replace them with hand-painted tiles at the visual checkpoints, as with
the grass and stone tiles.

## 9. Testing

| Area | Tests |
|---|---|
| Noise | Determinism against golden values; output ranges |
| Document | Valid and invalid cases with error paths; JSON round-trip including rasters |
| Ops | Shape, profile and blend math for each op |
| Pipeline | Golden hashes of showcase columns |
| Seams | Generating 3 × 3 columns separately equals generating the 96 × 96 block at once, so trees cross borders intact |
| Regeneration | Regenerating an area with the same document leaves the world identical to the initial generation. With a changed document, only the area changes. Regional light equals the light of a full generation |
| Engine | Parallel and serial generation give a byte-identical world |
| E2E | `?scene=terrain&size=256` (the `e2e.terrain.json` document) boots with a clean console |
| Benchmarks | ms per column (2D and 3D); full generation time |

## 10. Visual checkpoints

1. **Layout and relief:** the showcase with plain surface blocks. The user reviews the
   regions and the shape of every relief.
2. **Surface and biomes:** surface rules, biomes and the new textures.
3. **Trees and rocks:** feature density, tree shapes and rock sizes.
